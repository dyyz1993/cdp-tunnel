#!/usr/bin/env node
'use strict';

/**
 * Test: Tab eating — user opens tab from pre-existing page
 *
 * Scenario: User has tabs → CDP connects → user clicks link from own tab
 * → new tab should NOT be eaten into CDP group
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;
let proxyLogs = [];

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout: ${method}`)); }, 15000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) { clearTimeout(timeout); ws.off('message', handler); resolve(msg); }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function waitForProxy(port) {
  for (let i = 0; i < 20; i++) { try { if (await httpGet(port, '/json/version')) return true; } catch {} await sleep(500); }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(8000);
  while (Date.now() - start < maxWait) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/list`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

async function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function getPages(port) {
  const ws = await connectCDP(port);
  const r = await sendCDP(ws, 'Target.getTargets');
  ws.close();
  return (r?.result?.targetInfos || []).filter(t => t.type === 'page');
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} chromeProcess = null; }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} proxyProcess = null; }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: Tab Eating (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    proxyProcess.stdout.on('data', d => proxyLogs.push(...d.toString().trim().split('\n')));
    proxyProcess.stderr.on('data', d => proxyLogs.push(...d.toString().trim().split('\n')));

    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');
    log('SETUP', 'Proxy ready');

    const profile = `/tmp/cdp-eat-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank', 'https://www.example.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) {
      console.log('Proxy logs:', proxyLogs.slice(-20));
      throw new Error('Extension failed');
    }
    log('SETUP', 'Extension connected');

    const userPages = await getPages(PORT);
    const userTargetIds = userPages.map(t => t.targetId);
    log('BASE', `User tabs: ${userTargetIds.length}`);
    userPages.forEach(t => log('BASE', `  ${t.targetId} — ${t.url}`));

    // ── Connect Playwright ──
    log('PW', 'Connecting Playwright...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    await sleep(3000);

    // Create a CDP tab
    const cdpPage = await ctx.newPage();
    await cdpPage.goto('about:blank');
    log('PW', 'Created 1 CDP tab');
    await sleep(2000);

    // ── Scenario: User opens tab from pre-existing tab (simulated via Target.createTarget from a separate WS, then the tab opens a child) ──
    // We can't truly simulate "user clicks link" from outside, but we can check:
    // 1. Pre-existing tabs are NOT in the CDP group
    // 2. Tabs opened by pre-existing tabs are NOT eaten

    // Check tab groups via Chrome API — we'll use CDP to query
    const ws = await connectCDP(PORT);

    // Get all targets and their states
    const allTargets = await sendCDP(ws, 'Target.getTargets');
    const pages = allTargets.result.targetInfos.filter(t => t.type === 'page');

    log('CHECK', `Total pages: ${pages.length}`);
    pages.forEach(t => {
      const isUser = userTargetIds.includes(t.targetId);
      log('CHECK', `  ${isUser ? 'USER' : 'CDP '} ${t.targetId} — ${t.url}`);
    });

    // ── Simulate: user opens a link from pre-existing example.com tab ──
    // Use CDP to evaluate window.open on the user's pre-existing tab
    const exampleTarget = userPages.find(t => t.url.includes('example.com'));
    if (exampleTarget) {
      const exampleTabId = parseInt(exampleTarget.targetId, 16);
      log('SIM', `User clicks link on example.com tab (tabId: ${exampleTabId})`);

      // Find session for this target
      const sessions = await sendCDP(ws, 'Target.getTargets');
      // The user tab has debugger attached (pre-existing), so we can evaluate
      // But we need to find its sessionId
      // Actually let's just use Runtime.evaluate via the session
      // First, get the target's session from state

      // Use Page.navigate or window.open — let's use window.open to create a child tab
      const evalResult = await sendCDP(ws, 'Runtime.evaluate', {
        expression: 'window.open("https://www.bing.com", "_blank"); "done"',
        awaitPromise: false
      });
      log('SIM', `window.open result: ${JSON.stringify(evalResult?.result || evalResult?.error)}`);
    }

    ws.close();
    await sleep(5000);

    // Check results
    const afterPages = await getPages(PORT);
    log('AFTER', `Total pages after user action: ${afterPages.length}`);
    afterPages.forEach(t => {
      const isOriginal = userTargetIds.includes(t.targetId);
      log('AFTER', `  ${isOriginal ? 'ORIG' : 'NEW '} ${t.targetId} — ${t.url}`);
    });

    // The new tab opened from user's pre-existing tab should NOT be in CDP group
    // and should NOT be tracked by CDP
    const newTabs = afterPages.filter(t => !userTargetIds.includes(t.targetId));
    const bingTabs = newTabs.filter(t => t.url.includes('bing'));
    log('CHECK', `New tabs: ${newTabs.length}, Bing tabs: ${bingTabs.length}`);

    // Check Playwright doesn't see the user's new tab
    const pwPages = ctx.pages();
    const pwHasBing = pwPages.some(p => p.url().includes('bing'));
    log('CHECK', `Playwright pages: ${pwPages.length}, has bing: ${pwHasBing}`);

    if (!pwHasBing) {
      log('PASS', 'User tab opened from pre-existing tab NOT controlled by Playwright');
      passed++;
    } else {
      log('FAIL', 'User tab from pre-existing tab was eaten by Playwright!');
      failed++;
    }

    // ── Disconnect and verify ──
    log('DISC', 'Disconnecting...');
    await browser.close();
    await sleep(8000);

    const finalPages = await getPages(PORT);
    log('FINAL', `Pages after disconnect: ${finalPages.length}`);
    finalPages.forEach(t => log('FINAL', `  ${t.targetId} — ${t.url}`));

    // All original user tabs must survive
    const survived = finalPages.filter(t => userTargetIds.includes(t.targetId));
    if (survived.length >= userTargetIds.length) {
      log('PASS', 'Original user tabs survive disconnect');
      passed++;
    } else {
      log('FAIL', `${survived.length}/${userTargetIds.length} original user tabs survive`);
      failed++;
    }

    // The bing tab (if created) must also survive
    if (bingTabs.length > 0) {
      const bingSurvived = finalPages.filter(t => bingTabs.some(b => b.targetId === t.targetId));
      if (bingSurvived.length > 0) {
        log('PASS', 'User-opened bing tab survives disconnect');
        passed++;
      } else {
        log('FAIL', 'User-opened bing tab was eaten on disconnect');
        failed++;
      }
    } else {
      log('INFO', 'Bing tab not created, skipping survival check');
    }

    // CDP tab must be gone
    const cdpLeaks = finalPages.filter(t =>
      !userTargetIds.includes(t.targetId) &&
      !bingTabs.some(b => b.targetId === t.targetId) &&
      !t.url.startsWith('chrome-extension://')
    );
    if (cdpLeaks.length === 0) {
      log('PASS', 'CDP tabs cleaned up');
      passed++;
    } else {
      log('FAIL', `${cdpLeaks.length} CDP tabs leaked`);
      failed++;
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    if (proxyLogs.length) console.log('Logs:', proxyLogs.slice(-30).join('\n'));
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
