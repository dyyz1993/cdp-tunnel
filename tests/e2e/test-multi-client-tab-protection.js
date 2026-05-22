#!/usr/bin/env node
'use strict';

/**
 * Test: Multi-client tab protection + user tab between groups
 *
 * Scenarios:
 * 1. Two clients → two groups → disconnect one → other survives
 * 2. User tab between groups → survives both disconnects
 * 3. All user tabs survive full cleanup
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

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`T:${method}`)); }, 15000);
    const h = data => { try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', h); resolve(m); } } catch {} };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
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

async function getPages(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  const r = await sendCDP(ws, 'Target.getTargets');
  ws.close();
  return (r?.result?.targetInfos || []).filter(t => t.type === 'page');
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: Multi-Client Tab Protection (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-multi-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank', 'https://www.example.com', 'https://www.bing.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    const userPages = await getPages(PORT);
    const userTargetIds = userPages.map(t => t.targetId);
    log('BASE', `User tabs: ${userTargetIds.length}`);
    userPages.forEach(t => log('BASE', `  ${t.targetId} — ${t.url}`));

    // Connect client A
    log('A', 'Connecting client A...');
    const browserA = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctxA = browserA.contexts()[0];
    await sleep(2000);

    const pageA1 = await ctxA.newPage(); await pageA1.goto('about:blank');
    const pageA2 = await ctxA.newPage(); await pageA2.goto('about:blank');
    log('A', 'Created 2 CDP tabs for client A');
    await sleep(3000);

    // Connect client B (different CDP connection)
    log('B', 'Connecting client B...');
    const browserB = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctxB = browserB.contexts()[0];
    await sleep(2000);

    const pageB1 = await ctxB.newPage(); await pageB1.goto('about:blank');
    log('B', 'Created 1 CDP tab for client B');
    await sleep(3000);

    // Snapshot
    const midPages = await getPages(PORT);
    log('MID', `Total pages: ${midPages.length}`);
    midPages.forEach(t => {
      const isUser = userTargetIds.includes(t.targetId);
      log('MID', `  ${isUser ? 'USER' : 'CDP '} ${t.targetId} — ${t.url}`);
    });

    // ── Scenario 1: Disconnect client A, B should survive ──
    log('S1', 'Disconnecting client A...');
    await browserA.close();
    await sleep(8000);

    const afterA = await getPages(PORT);
    log('S1', `After A disconnect: ${afterA.length} pages`);
    afterA.forEach(t => log('S1', `  ${t.targetId} — ${t.url}`));

    // All user tabs must survive
    const survivedA = afterA.filter(t => userTargetIds.includes(t.targetId));
    if (survivedA.length >= userTargetIds.length) {
      log('PASS', 'S1: User tabs survive client A disconnect');
      passed++;
    } else {
      log('FAIL', `S1: ${survivedA.length}/${userTargetIds.length} user tabs survive`);
      failed++;
    }

    // Client B should still be functional — try creating a new page
    try {
      const pageB2 = await ctxB.newPage();
      await pageB2.goto('about:blank');
      log('PASS', `S1: Client B still functional after A disconnect`);
      passed++;
    } catch (e) {
      log('FAIL', `S1: Client B broken after A disconnect: ${e.message}`);
      failed++;
    }

    // ── Scenario 2: Disconnect client B ──
    log('S2', 'Disconnecting client B...');
    await browserB.close();
    await sleep(8000);

    const finalPages = await getPages(PORT);
    log('S2', `After B disconnect: ${finalPages.length} pages`);
    finalPages.forEach(t => log('S2', `  ${t.targetId} — ${t.url}`));

    const survivedFinal = finalPages.filter(t => userTargetIds.includes(t.targetId));
    if (survivedFinal.length >= userTargetIds.length) {
      log('PASS', 'S2: User tabs survive both disconnects');
      passed++;
    } else {
      log('FAIL', `S2: ${survivedFinal.length}/${userTargetIds.length} user tabs survive`);
      failed++;
    }

    // No CDP tabs leaked
    const leaks = finalPages.filter(t =>
      !userTargetIds.includes(t.targetId) && !t.url.startsWith('chrome-extension://')
    );
    if (leaks.length === 0) {
      log('PASS', 'S2: No CDP tabs leaked');
      passed++;
    } else {
      log('FAIL', `S2: ${leaks.length} CDP tabs leaked`);
      failed++;
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
