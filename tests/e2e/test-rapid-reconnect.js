#!/usr/bin/env node
'use strict';

/**
 * Test: Rapid connect/disconnect cycles don't leak state or cause failures
 *
 * 1. 5 rapid connect/disconnect cycles — no state leaks
 * 2. 2 clients simultaneous disconnect — clean cleanup
 * 3. Connect immediately after disconnect — no interference
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PORT = 10000 + Math.floor(Math.random() * 50000);
if (PORT === 9221) process.exit(1);

const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let originalConfig = null;
let _requestId = 0;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function patchConfig(port) {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH,
    originalConfig.replace(
      /WS_URL:\s*'ws:\/\/localhost:\d+\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (originalConfig) {
    fs.writeFileSync(CONFIG_PATH, originalConfig);
    originalConfig = null;
  }
}

function sendCDP(ws, method, params = {}) {
  const id = ++_requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout [${id}]: ${method}`));
    }, 15000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(port, '/json/version');
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(5000);
  while (Date.now() - start < maxWait) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/list`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        }).on('error', reject);
      });
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

function cleanup() {
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    if (chromeProcess._profile) {
      try { fs.rmSync(chromeProcess._profile, { recursive: true, force: true }); } catch {}
    }
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

function getUserPages(targetInfos) {
  return (targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
}

async function getBaselineTabCount() {
  const list = await httpGet(PORT, '/json/list');
  return (list || []).filter(t => t.type === 'page').length;
}

async function runTest() {
  console.log(`\n=== Test: Rapid Reconnect (port ${PORT}) ===\n`);
  const results = [];

  try {
    patchConfig(PORT);
    log('SETUP', 'Patched extension config');

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('PROXY-ERR', l));
    });

    if (!await waitForProxy(PORT)) throw new Error('Proxy did not become ready');
    log('SETUP', 'Proxy ready');

    const userDataDir = `/tmp/cdp-rapid-reconnect-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;

    if (!await waitForExtension(PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    const baselineTabs = await getBaselineTabCount();
    log('SETUP', `Baseline tabs: ${baselineTabs}`);

    // ══════════════════════════════════════════════════════════════════
    // TEST 1: 5 rapid connect/disconnect cycles
    // ══════════════════════════════════════════════════════════════════
    log('TEST1', '--- 5 rapid connect/disconnect cycles ---');

    for (let i = 0; i < 5; i++) {
      log('TEST1', `Cycle ${i + 1}/5: connecting...`);
      const ws = await connectCDP(PORT);
      await sendCDP(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
      await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

      const created = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
      log('TEST1', `Cycle ${i + 1}: created page ${created.targetId.substring(0, 12)}...`);

      await sleep(1000);

      const targets = await sendCDP(ws, 'Target.getTargets');
      const pages = getUserPages(targets.targetInfos);
      const hasCreated = pages.some(p => p.targetId === created.targetId);
      results.push({ name: `Cycle ${i + 1}: page visible before disconnect`, pass: hasCreated });
      log('TEST1', `Cycle ${i + 1}: ${pages.length} pages, created page ${hasCreated ? 'found' : 'MISSING'}`);

      log('TEST1', `Cycle ${i + 1}: disconnecting immediately`);
      ws.terminate();
    }

    log('TEST1', 'Waiting 5s for final cleanup...');
    await sleep(5000);

    log('TEST1', 'Connecting 6th client to verify no leftover pages...');
    const wsVerify1 = await connectCDP(PORT);
    await sendCDP(wsVerify1, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    const verifyTargets1 = await sendCDP(wsVerify1, 'Target.getTargets');
    const verifyPages1 = getUserPages(verifyTargets1.targetInfos);
    const noLeftovers1 = verifyPages1.length <= baselineTabs;
    results.push({ name: 'Test1: 0 leftover pages after 5 cycles', pass: noLeftovers1 });
    log('TEST1', `After cleanup: ${verifyPages1.length} pages (baseline: ${baselineTabs}) — ${noLeftovers1 ? 'PASS' : 'FAIL'}`);

    wsVerify1.terminate();
    log('TEST1', 'Waiting 5s for inter-phase stabilization...');
    await sleep(5000);

    // ══════════════════════════════════════════════════════════════════
    // TEST 2: 2 clients simultaneous disconnect
    // ══════════════════════════════════════════════════════════════════
    log('TEST2', '--- 2 clients simultaneous disconnect ---');

    const wsA = await connectCDP(PORT);
    const wsB = await connectCDP(PORT);
    await sendCDP(wsA, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
    await sendCDP(wsB, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
    await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });
    await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });
    log('TEST2', 'Client A and Client B connected');

    const aPages = [];
    const bPages = [];
    for (let i = 0; i < 2; i++) {
      const r = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
      aPages.push(r.targetId);
    }
    for (let i = 0; i < 2; i++) {
      const r = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
      bPages.push(r.targetId);
    }
    log('TEST2', `A created: ${aPages.map(p => p.substring(0, 12)).join(', ')}`);
    log('TEST2', `B created: ${bPages.map(p => p.substring(0, 12)).join(', ')}`);

    await sleep(3000);

    const targetsA = await sendCDP(wsA, 'Target.getTargets');
    const targetsB = await sendCDP(wsB, 'Target.getTargets');
    const aOnly = getUserPages(targetsA.targetInfos).filter(p => aPages.includes(p.targetId));
    const bOnly = getUserPages(targetsB.targetInfos).filter(p => bPages.includes(p.targetId));
    const aSeesB = getUserPages(targetsA.targetInfos).filter(p => bPages.includes(p.targetId));
    const bSeesA = getUserPages(targetsB.targetInfos).filter(p => aPages.includes(p.targetId));

    const isolationOk = aOnly.length === 2 && bOnly.length === 2 && aSeesB.length === 0 && bSeesA.length === 0;
    results.push({ name: 'Test2: each client sees only own 2 pages', pass: isolationOk });
    log('TEST2', `A sees own: ${aOnly.length}, B pages: ${aSeesB.length}`);
    log('TEST2', `B sees own: ${bOnly.length}, A pages: ${bSeesA.length} — ${isolationOk ? 'PASS' : 'FAIL'}`);

    log('TEST2', 'Disconnecting BOTH simultaneously...');
    wsA.terminate();
    wsB.terminate();

    log('TEST2', 'Waiting 8s for cleanup...');
    await sleep(8000);

    log('TEST2', 'Connecting Client C to verify cleanup...');
    const wsC = await connectCDP(PORT);
    await sendCDP(wsC, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    const targetsC = await sendCDP(wsC, 'Target.getTargets');
    const pagesC = getUserPages(targetsC.targetInfos);
    const allCreated = [...aPages, ...bPages];
    const remnantsC = pagesC.filter(p => allCreated.includes(p.targetId));
    const noLeftovers2 = remnantsC.length === 0 && pagesC.length <= baselineTabs;
    results.push({ name: 'Test2: 0 leftover pages after simultaneous disconnect', pass: noLeftovers2 });
    log('TEST2', `${pagesC.length} pages (baseline: ${baselineTabs}), remnants: ${remnantsC.length} — ${noLeftovers2 ? 'PASS' : 'FAIL'}`);

    wsC.terminate();
    log('TEST2', 'Waiting 5s for inter-phase stabilization...');
    await sleep(5000);

    // ══════════════════════════════════════════════════════════════════
    // TEST 3: Connect immediately after disconnect (no wait)
    // ══════════════════════════════════════════════════════════════════
    log('TEST3', '--- Connect immediately after disconnect (no wait) ---');

    const wsA3 = await connectCDP(PORT);
    await sendCDP(wsA3, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
    await sendCDP(wsA3, 'Target.setDiscoverTargets', { discover: true });

    const pageA3 = await sendCDP(wsA3, 'Target.createTarget', { url: 'about:blank' });
    log('TEST3', `Client A created page ${pageA3.targetId.substring(0, 12)}...`);

    await sleep(1000);

    log('TEST3', 'Disconnecting Client A...');
    wsA3.terminate();

    log('TEST3', 'IMMEDIATELY connecting Client B (no wait)...');
    const wsB3 = await connectCDP(PORT);
    await sendCDP(wsB3, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
    await sendCDP(wsB3, 'Target.setDiscoverTargets', { discover: true });

    const pageB3 = await sendCDP(wsB3, 'Target.createTarget', { url: 'about:blank' });
    log('TEST3', `Client B created page ${pageB3.targetId.substring(0, 12)}... — should succeed`);

    results.push({ name: 'Test3: Client B creates page immediately after A disconnect', pass: !!pageB3.targetId });

    await sleep(5000);

    const targetsB3 = await sendCDP(wsB3, 'Target.getTargets');
    const pagesB3 = getUserPages(targetsB3.targetInfos);
    const b3OwnPage = pagesB3.filter(p => p.targetId === pageB3.targetId);
    const a3Remnants = pagesB3.filter(p => p.targetId === pageA3.targetId);
    const b3Ok = b3OwnPage.length === 1 && a3Remnants.length === 0;
    results.push({ name: 'Test3: Client B still has its page (not affected by A cleanup)', pass: b3Ok });
    log('TEST3', `B own page: ${b3OwnPage.length}, A remnants: ${a3Remnants.length} — ${b3Ok ? 'PASS' : 'FAIL'}`);

    log('TEST3', 'Disconnecting Client B...');
    wsB3.terminate();

    log('TEST3', 'Waiting 5s...');
    await sleep(5000);

    log('TEST3', 'Connecting Client C to verify 0 leftovers...');
    const wsC3 = await connectCDP(PORT);
    await sendCDP(wsC3, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    const targetsC3 = await sendCDP(wsC3, 'Target.getTargets');
    const pagesC3 = getUserPages(targetsC3.targetInfos);
    const allCreated3 = [pageA3.targetId, pageB3.targetId];
    const remnantsC3 = pagesC3.filter(p => allCreated3.includes(p.targetId));
    const noLeftovers3 = remnantsC3.length === 0 && pagesC3.length <= baselineTabs;
    results.push({ name: 'Test3: 0 leftover pages final check', pass: noLeftovers3 });
    log('TEST3', `${pagesC3.length} pages (baseline: ${baselineTabs}), remnants: ${remnantsC3.length} — ${noLeftovers3 ? 'PASS' : 'FAIL'}`);

    wsC3.terminate();
    await sleep(1000);

  } catch (err) {
    console.error('\nFATAL:', err.message);
    results.push({ name: 'Test execution', pass: false });
  }

  cleanup();

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n=== RESULTS ===');
  results.forEach(r => {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.name}`);
  });
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
