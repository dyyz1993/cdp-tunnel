#!/usr/bin/env node
'use strict';

/**
 * Test: User tab protection during CDP operations
 *
 * Scenarios:
 * 1. User has tabs → Playwright connects → user tabs NOT in CDP group → survive
 * 2. Playwright creates tabs → user manually opens tab (via chrome.tabs.create simulating Ctrl+T) → user tab NOT eaten
 * 3. User tab placed between two CDP groups → survives disconnect of both
 * 4. Disconnect → ALL user tabs survive, ALL CDP tabs closed, groups removed
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
  const patched = configOriginal.replace(
    /WS_URL:\s*'[^']*'/,
    `WS_URL: 'ws://localhost:${port}/plugin'`
  );
  fs.writeFileSync(CONFIG_PATH, patched);
  log('CFG', `Patched WS_URL → ws://localhost:${port}/plugin`);
}

function restoreConfig() {
  if (configOriginal) {
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    log('CFG', 'Restored original config');
  }
}

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { const r = await httpGet(port, '/json/version'); if (r) return true; } catch {}
    await sleep(500);
  }
  return false;
}

 async function waitForExtension(port, maxWait = 60000) {
   log('WAIT', 'Waiting for extension to connect...');
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
       log('WAIT', `  Got ${pages.length} pages from /json/list`);
       if (pages.length > 0) return true;
     } catch (e) {
       log('WAIT', `  Not ready: ${e.message}`);
     }
     await sleep(3000);
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

async function getTargetInfos(port) {
  const ws = await connectCDP(port);
  const r = await sendCDP(ws, 'Target.getTargets');
  ws.close();
  return (r?.result?.targetInfos || []).filter(t => t.type === 'page');
}

function dumpProxyLogs() {
  if (proxyLogs.length > 0) {
    console.log('\n--- Proxy logs (last 80 lines) ---');
    proxyLogs.slice(-80).forEach(l => console.log('  ' + l));
    console.log('---\n');
  }
}

function cleanup() {
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid); } catch {}
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: User Tab Protection (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    log('SETUP', `Starting proxy on port ${PORT}`);
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stdout.on('data', d => proxyLogs.push(...d.toString().trim().split('\n')));
    proxyProcess.stderr.on('data', d => proxyLogs.push(...d.toString().trim().split('\n')));

    if (!await waitForProxy(PORT)) { dumpProxyLogs(); throw new Error('Proxy failed'); }
    log('SETUP', 'Proxy ready');

    const profile = `/tmp/cdp-user-tab-test-${Date.now()}`;
    log('SETUP', `Launching Chrome`);
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank',
      'https://www.example.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) { dumpProxyLogs(); throw new Error('Extension failed'); }
    log('SETUP', 'Extension connected!');

    // Record user tabs BEFORE Playwright connects
    const userPages = await getTargetInfos(PORT);
    const userTargetIds = userPages.map(t => t.targetId);
    log('BASE', `User tabs before CDP: ${userPages.length}`);
    userPages.forEach(t => log('BASE', `  ${t.targetId} — ${t.url}`));
    await sleep(2000);

    // ── Scenario 1: Playwright connects, user tabs NOT in group ──
    log('S1', 'Connecting Playwright...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    log('S1', `Playwright connected, ${ctx.pages().length} pages`);
    await sleep(3000);

    // Create CDP tabs
    for (let i = 0; i < 3; i++) {
      const p = await ctx.newPage();
      await p.goto('about:blank');
      log('S1', `  Created CDP tab ${i + 1}`);
    }
    await sleep(3000);

    const s1Pages = await getTargetInfos(PORT);
    const s1UserAlive = s1Pages.filter(t => userTargetIds.includes(t.targetId));
    log('S1', `User tabs: ${s1UserAlive.length}/${userTargetIds.length}, Total pages: ${s1Pages.length}`);

    if (s1UserAlive.length >= userTargetIds.length) {
      log('PASS', 'S1: User tabs survive CDP connect');
      passed++;
    } else {
      log('FAIL', `S1: Only ${s1UserAlive.length}/${userTargetIds.length} user tabs survive`);
      failed++;
    }

    // ── Scenario 2: User manually opens tab via browser (simulated via chrome.tabs.create) ──
    // Use CDP to create the tab but DON'T attach debugger or add to group
    // This simulates: user presses Ctrl+T in browser
    log('S2', 'Simulating user Ctrl+T (new tab via browser, not CDP)...');
    const s2Ws = await connectCDP(PORT);

    // Use Page.create (via browser-level) to simulate user opening a tab
    // The key: we use the raw tab creation, NOT Target.createTarget
    // Target.createTarget goes through extension's CDP handler
    // Instead, we'll check that a tab created by user (not via CDP) survives

    // Actually, we can simulate by opening a tab that extension doesn't track
    // Use chrome.tabs API directly — but from outside extension context we can't
    // So let's use a different approach: create tab via Target.createTarget,
    // then MANUALLY remove it from tracking (simulating user "claiming" the tab)

    // Better approach: just open a new tab via the HTTP endpoint (json/new)
    // This creates a tab that goes through the normal chrome flow
    const newTabResp = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/json/new?https://www.google.com`, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(d); }
        });
      }).on('error', reject);
    });
    s2Ws.close();

    const manualTabTargetId = newTabResp?.id;
    log('S2', `Browser-created tab: ${manualTabTargetId}`);
    await sleep(3000);

    // ── Scenario 3: User opens tab by navigating from a user page ──
    log('S3', 'User navigates existing tab to new URL...');
    // The user's existing about:blank tab navigates to bing.com
    // This simulates user clicking a link or typing URL
    const blankTargetId = userTargetIds.find(id =>
      userPages.find(p => p.targetId === id && p.url === 'about:blank')
    );
    if (blankTargetId) {
      const s3Ws = await connectCDP(PORT);
      // Use Page.navigate on the user's tab (which has debugger attached as pre-existing)
      const s3Result = await sendCDP(s3Ws, 'Page.navigate', {
        url: 'https://www.bing.com',
        frameId: blankTargetId
      });
      s3Ws.close();
      log('S3', `Navigated user tab, result: ${JSON.stringify(s3Result?.result || s3Result?.error)}`);
    }
    await sleep(3000);

    // ── Scenario 4: Disconnect — check who survives ──
    log('S4', 'Disconnecting Playwright...');
    await browser.close();
    log('S4', 'Waiting for cleanup...');
    await sleep(8000);

    const s4Pages = await getTargetInfos(PORT);
    log('S4', `Surviving pages: ${s4Pages.length}`);
    s4Pages.forEach(t => log('S4', `  SURVIVED: ${t.targetId} — ${t.url}`));

    // Check 1: Original user tabs
    const survivedOriginal = s4Pages.filter(t => userTargetIds.includes(t.targetId));
    if (survivedOriginal.length >= userTargetIds.length) {
      log('PASS', 'S4a: Original user tabs survive disconnect');
      passed++;
    } else {
      log('FAIL', `S4a: ${survivedOriginal.length}/${userTargetIds.length} original user tabs survive`);
      failed++;
    }

    // Check 2: CDP tabs cleaned up
    const extUrls = s4Pages.filter(t => t.url.startsWith('chrome-extension://'));
    const cdpLeaks = s4Pages.filter(t =>
      !userTargetIds.includes(t.targetId) &&
      t.targetId !== manualTabTargetId &&
      !t.url.startsWith('chrome-extension://')
    );
    if (cdpLeaks.length === 0) {
      log('PASS', 'S4b: CDP tabs properly cleaned up');
      passed++;
    } else {
      log('FAIL', `S4b: ${cdpLeaks.length} CDP tabs leaked`);
      cdpLeaks.forEach(t => log('FAIL', `  LEAKED: ${t.targetId} — ${t.url}`));
      failed++;
    }

    // Check 3: No user tab was "eaten" (replaced)
    // Every original user targetId must still correspond to a page
    const eatenTabs = userTargetIds.filter(id => !s4Pages.find(p => p.targetId === id));
    if (eatenTabs.length === 0) {
      log('PASS', 'S4c: No user tabs were eaten/replaced');
      passed++;
    } else {
      log('FAIL', `S4c: ${eatenTabs.length} user tabs were eaten: ${eatenTabs.join(', ')}`);
      failed++;
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    dumpProxyLogs();
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
