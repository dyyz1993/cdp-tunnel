#!/usr/bin/env node
'use strict';

/**
 * Test: Client disconnecting mid-operation doesn't leave stale state
 *
 * 1. Disconnect during createTarget
 * 2. Disconnect during rapid multi-createTarget
 * 3. Connect/disconnect 3 cycles in rapid succession
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 10000 + Math.floor(Math.random() * 50000);
if (PORT === 9221) process.exit(1);

const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;
let profile = null;
let _reqId = 0;

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) { fs.writeFileSync(CONFIG_PATH, configOriginal); configOriginal = null; } }

function sendCDP(ws, method, params = {}) {
  const id = ++_reqId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`Timeout: ${method}`)); }, 15000);
    const h = data => {
      try {
        const m = JSON.parse(data.toString());
        if (m.id === id) { clearTimeout(t); ws.off('message', h); resolve(m); }
      } catch {}
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sendCDPNoWait(ws, method, params = {}) {
  const id = ++_reqId;
  ws.send(JSON.stringify({ id, method, params }));
  return id;
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

async function waitForProxy(port) {
  for (let i = 0; i < 30; i++) { try { if (await httpGet(port, '/json/version')) return true; } catch {} await sleep(500); }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(6000);
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

function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function getVisiblePages(ws) {
  const targets = await sendCDP(ws, 'Target.getTargets');
  return (targets.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
}

async function getBaselinePageCount(port) {
  const ws = await connectCDP(port);
  await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
  await sleep(1000);
  const pages = await getVisiblePages(ws);
  ws.close();
  await sleep(1000);
  return pages.length;
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {} chromeProcess = null; }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} proxyProcess = null; }
  restoreConfig();
}

async function runTest() {
  console.log(`\n=== Test: Mid-Operation Disconnect (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');
    log('SETUP', 'Proxy ready');

    profile = `/tmp/cdp-midop-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Extension connected');

    // ── Get baseline page count ──
    const baseline = await getBaselinePageCount(PORT);
    log('BASELINE', `Baseline pages: ${baseline}`);

    // ============================================================
    // Test 1: Disconnect during createTarget
    // ============================================================
    log('TEST1', '── Disconnect during createTarget ──');
    {
      const ws1 = await connectCDP(PORT);
      await sendCDP(ws1, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await sendCDP(ws1, 'Target.setDiscoverTargets', { discover: true });

      log('TEST1', 'Sending createTarget then IMMEDIATELY closing...');
      sendCDPNoWait(ws1, 'Target.createTarget', { url: 'about:blank' });
      ws1.terminate();

      log('TEST1', 'Waiting 5s for cleanup...');
      await sleep(5000);

      log('TEST1', 'Connecting new client to check state...');
      const ws1b = await connectCDP(PORT);
      await sendCDP(ws1b, 'Target.setDiscoverTargets', { discover: true });
      await sleep(1000);

      const pages1 = await getVisiblePages(ws1b);
      log('TEST1', `New client sees ${pages1.length} pages (baseline: ${baseline})`);

      if (pages1.length <= baseline) {
        log('PASS', 'Test 1a: No leftover pages after mid-createTarget disconnect');
        passed++;
      } else {
        log('FAIL', `Test 1a: ${pages1.length - baseline} leftover pages!`);
        failed++;
      }

      const browserList1 = await httpGet(PORT, '/json/list');
      const browserPages1 = (browserList1 || []).filter(t => t.type === 'page');
      if (browserPages1.length <= baseline + 1) {
        log('PASS', `Test 1b: Browser tabs at baseline (${browserPages1.length} vs ${baseline})`);
        passed++;
      } else {
        log('FAIL', `Test 1b: Browser has ${browserPages1.length} tabs (baseline ${baseline})`);
        failed++;
      }

      ws1b.close();
      await sleep(2000);
    }

    // ============================================================
    // Test 2: Disconnect during rapid multi-createTarget
    // ============================================================
    log('TEST2', '── Disconnect during rapid multi-createTarget ──');
    {
      const ws2 = await connectCDP(PORT);
      await sendCDP(ws2, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await sendCDP(ws2, 'Target.setDiscoverTargets', { discover: true });

      log('TEST2', 'Sending 5 createTarget requests rapidly then closing...');
      for (let i = 0; i < 5; i++) {
        sendCDPNoWait(ws2, 'Target.createTarget', { url: 'about:blank' });
      }
      ws2.terminate();

      log('TEST2', 'Waiting 8s for cleanup...');
      await sleep(8000);

      log('TEST2', 'Connecting new client to check state...');
      const ws2b = await connectCDP(PORT);
      await sendCDP(ws2b, 'Target.setDiscoverTargets', { discover: true });
      await sleep(1000);

      const pages2 = await getVisiblePages(ws2b);
      log('TEST2', `New client sees ${pages2.length} pages (baseline: ${baseline})`);

      if (pages2.length <= baseline) {
        log('PASS', 'Test 2a: No leftover pages after rapid multi-create disconnect');
        passed++;
      } else {
        log('FAIL', `Test 2a: ${pages2.length - baseline} leftover pages!`);
        failed++;
      }

      const browserList2 = await httpGet(PORT, '/json/list');
      const browserPages2 = (browserList2 || []).filter(t => t.type === 'page');
      if (browserPages2.length <= baseline + 2) {
        log('PASS', `Test 2b: Browser tabs near baseline (${browserPages2.length} vs ${baseline})`);
        passed++;
      } else {
        log('FAIL', `Test 2b: Browser has ${browserPages2.length} tabs (baseline ${baseline})`);
        failed++;
      }

      ws2b.close();
      await sleep(2000);
    }

    // ============================================================
    // Test 3: Connect/disconnect 3 cycles in rapid succession
    // ============================================================
    log('TEST3', '── Connect/disconnect 3 rapid cycles ──');
    {
      // Cycle 1
      log('TEST3', 'Cycle 1: connect, create 1 page, disconnect immediately');
      const ws3a = await connectCDP(PORT);
      await sendCDP(ws3a, 'Target.setDiscoverTargets', { discover: true });
      sendCDPNoWait(ws3a, 'Target.createTarget', { url: 'about:blank' });
      ws3a.terminate();

      await sleep(3000);

      // Cycle 2
      log('TEST3', 'Cycle 2: connect, create 1 page, disconnect immediately');
      const ws3b = await connectCDP(PORT);
      await sendCDP(ws3b, 'Target.setDiscoverTargets', { discover: true });
      sendCDPNoWait(ws3b, 'Target.createTarget', { url: 'about:blank' });
      ws3b.terminate();

      await sleep(3000);

      // Cycle 3: connect normally, verify 0 leftovers
      log('TEST3', 'Cycle 3: connect normally, check state');
      const ws3c = await connectCDP(PORT);
      await sendCDP(ws3c, 'Target.setDiscoverTargets', { discover: true });
      await sleep(1000);

      const pages3c = await getVisiblePages(ws3c);
      log('TEST3', `Cycle 3 client sees ${pages3c.length} pages (baseline: ${baseline})`);

      if (pages3c.length <= baseline) {
        log('PASS', 'Test 3a: No leftover pages after 3 rapid cycles');
        passed++;
      } else {
        log('FAIL', `Test 3a: ${pages3c.length - baseline} leftover pages after cycles!`);
        failed++;
      }

      // Create 1 page, verify it works
      const r3 = await sendCDP(ws3c, 'Target.createTarget', { url: 'about:blank' });
      if (r3.result?.targetId) {
        log('PASS', 'Test 3b: createTarget works after rapid cycles');
        passed++;
      } else {
        log('FAIL', `Test 3b: createTarget failed: ${JSON.stringify(r3)}`);
        failed++;
      }

      ws3c.close();
      await sleep(5000);

      // Final verification: new client sees 0 leftovers
      log('TEST3', 'Final verification: new client checks for leftovers');
      const ws3d = await connectCDP(PORT);
      await sendCDP(ws3d, 'Target.setDiscoverTargets', { discover: true });
      await sleep(1000);

      const pages3d = await getVisiblePages(ws3d);
      log('TEST3', `Final client sees ${pages3d.length} pages (baseline: ${baseline})`);

      if (pages3d.length <= baseline) {
        log('PASS', 'Test 3c: Clean state after all cycles');
        passed++;
      } else {
        log('FAIL', `Test 3c: ${pages3d.length - baseline} leftover pages in final check!`);
        failed++;
      }

      ws3d.close();
      await sleep(1000);
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
