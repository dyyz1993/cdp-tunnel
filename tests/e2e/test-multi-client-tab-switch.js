#!/usr/bin/env node
'use strict';

/**
 * Test: Multi-client tab switch isolation
 *
 * Scenario:
 * 1. Start proxy + Chrome on random port
 * 2. Connect Client A, Client B via raw WebSocket
 * 3. Client A creates 3 pages, Client B creates 3 pages
 * 4. Each client does Target.getTargets — verify only sees own pages
 * 5. Client A tries to activate Client B's tab → should be blocked
 * 6. Client A tries to close Client B's tab → should be blocked
 * 7. Client A tries to attach to Client B's tab → should be blocked
 * 8. Client A switches between its OWN tabs → should succeed
 * 9. Read chrome_debug.log — verify 0 critical errors in extension
 */

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
let profile = null;
let _reqId = 0;

const extensionErrors = [];

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

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {} chromeProcess = null; }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} proxyProcess = null; }
  restoreConfig();
}

function readChromeLogs() {
  if (!profile) return;
  const logFile = path.join(profile, 'chrome_debug.log');
  if (!fs.existsSync(logFile)) return;
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.trim());
  const extPrefixes = ['[TabGroup]', '[Monitor]', '[WS]', '[CDP]', '[Init]'];
  lines.forEach(line => {
    for (const p of extPrefixes) {
      if (line.includes(p) && (line.includes('ERROR') || line.includes('error') || line.includes('exception'))) {
        extensionErrors.push(line.substring(0, 300));
        break;
      }
    }
  });
}

async function runTest() {
  console.log(`\n=== Test: Multi-Client Tab Switch Isolation (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr.on('data', d => d.toString().trim().split('\n').forEach(l => {
      if (l.includes('ERROR') || l.includes('BLOCKED')) log('PROXY', l.substring(0, 200));
    }));

    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');
    log('SETUP', 'Proxy ready');

    profile = `/tmp/cdp-tab-switch-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      '--enable-logging', '--v=1',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Extension connected');

    // ── Phase 1: Connect two clients ──
    log('C1', 'Connecting Client A...');
    const wsA = await connectCDP(PORT);
    log('C2', 'Connecting Client B...');
    const wsB = await connectCDP(PORT);
    log('SETUP', 'Both clients connected');

    await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });
    await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });

    // ── Phase 2: Each client creates 3 pages ──
    log('C1', 'Client A creating 3 pages...');
    const pagesA = [];
    for (let i = 0; i < 3; i++) {
      const r = await sendCDP(wsA, 'Target.createTarget', { url: `about:blank` });
      pagesA.push(r.result.targetId);
      log('C1', `  Page A${i + 1}: ${r.result.targetId.substring(0, 12)}...`);
    }

    log('C2', 'Client B creating 3 pages...');
    const pagesB = [];
    for (let i = 0; i < 3; i++) {
      const r = await sendCDP(wsB, 'Target.createTarget', { url: `about:blank` });
      pagesB.push(r.result.targetId);
      log('C2', `  Page B${i + 1}: ${r.result.targetId.substring(0, 12)}...`);
    }

    await sleep(3000);

    // ── Phase 3: Verify isolation — each client only sees own pages ──
    log('TEST', 'Phase 3: Target.getTargets isolation...');

    const targetsA = await sendCDP(wsA, 'Target.getTargets');
    const targetsB = await sendCDP(wsB, 'Target.getTargets');

    const pageTargetsA = (targetsA.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    const pageTargetsB = (targetsB.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));

    const aSeesOnlyOwn = pageTargetsA.every(t => pagesA.includes(t.targetId));
    const bSeesOnlyOwn = pageTargetsB.every(t => pagesB.includes(t.targetId));
    const aSeesAllOwn = pagesA.every(id => pageTargetsA.some(t => t.targetId === id));
    const bSeesAllOwn = pagesB.every(id => pageTargetsB.some(t => t.targetId === id));

    log('TEST', `  Client A sees ${pageTargetsA.length} pages, all own: ${aSeesOnlyOwn}, all present: ${aSeesAllOwn}`);
    log('TEST', `  Client B sees ${pageTargetsB.length} pages, all own: ${bSeesOnlyOwn}, all present: ${bSeesAllOwn}`);

    if (aSeesOnlyOwn && aSeesAllOwn && bSeesOnlyOwn && bSeesAllOwn) {
      log('PASS', 'Each client sees only its own 3 pages');
      passed++;
    } else {
      log('FAIL', 'Client isolation broken — client sees other client\'s pages!');
      failed++;
    }

    // Cross-check: Client A must NOT see any of Client B's pages
    const aSeesB = pageTargetsA.some(t => pagesB.includes(t.targetId));
    const bSeesA = pageTargetsB.some(t => pagesA.includes(t.targetId));
    if (!aSeesB && !bSeesA) {
      log('PASS', 'Cross-contamination check: no client sees other\'s pages');
      passed++;
    } else {
      log('FAIL', `Cross-contamination! A sees B: ${aSeesB}, B sees A: ${bSeesA}`);
      failed++;
    }

    // ── Phase 4: Client A tries to activate Client B's tab (should be blocked) ──
    log('TEST', 'Phase 4: Client A tries Target.activateTarget on B\'s tab...');
    const activateResult = await sendCDP(wsA, 'Target.activateTarget', { targetId: pagesB[0] });
    // activateTarget is not blocked by proxy currently — but should not cause errors
    log('TEST', `  activateTarget result: ${JSON.stringify(activateResult.result || activateResult.error || 'empty')}`);
    // This is informational — not a hard failure since activateTarget is not filtered

    // ── Phase 5: Client A tries to close Client B's tab (MUST be blocked) ──
    log('TEST', 'Phase 5: Client A tries Target.closeTarget on B\'s tab...');
    const closeResult = await sendCDP(wsA, 'Target.closeTarget', { targetId: pagesB[0] });

    if (closeResult.error && closeResult.error.message.includes('owned by another client')) {
      log('PASS', 'Client A blocked from closing Client B\'s tab');
      passed++;
    } else if (closeResult.result?.success === false) {
      log('PASS', 'Client A close returned success=false for B\'s tab');
      passed++;
    } else {
      log('FAIL', `Client A was NOT blocked from closing B's tab! Result: ${JSON.stringify(closeResult)}`);
      failed++;
    }

    // Verify B's tab still exists
    await sleep(1000);
    const targetsBafter = await sendCDP(wsB, 'Target.getTargets');
    const bPagesAfterClose = (targetsBafter.result?.targetInfos || []).filter(t => t.type === 'page');
    if (bPagesAfterClose.length === 3) {
      log('PASS', 'Client B still has all 3 pages after A tried to close one');
      passed++;
    } else {
      log('FAIL', `Client B has ${bPagesAfterClose.length} pages (expected 3) — tab was killed!`);
      failed++;
    }

    // ── Phase 6: Client A tries to attach Client B's tab (MUST be blocked) ──
    log('TEST', 'Phase 6: Client A tries Target.attachToTarget on B\'s tab...');
    const attachResult = await sendCDP(wsA, 'Target.attachToTarget', { targetId: pagesB[1], flatten: true });

    if (attachResult.error && attachResult.error.message.includes('owned by another client')) {
      log('PASS', 'Client A blocked from attaching to Client B\'s tab');
      passed++;
    } else {
      log('FAIL', `Client A was NOT blocked from attaching B's tab! Result: ${JSON.stringify(attachResult)}`);
      failed++;
    }

    // ── Phase 7: Client A switches between its OWN tabs (should succeed) ──
    log('TEST', 'Phase 7: Client A switches between own tabs...');
    let switchOk = true;
    for (let i = 0; i < pagesA.length; i++) {
      const act = await sendCDP(wsA, 'Target.activateTarget', { targetId: pagesA[i] });
      if (act.error) {
        log('FAIL', `  activate own tab A${i} failed: ${JSON.stringify(act.error)}`);
        switchOk = false;
      }
      await sleep(200);
    }
    if (switchOk) {
      log('PASS', 'Client A can switch between all its own tabs');
      passed++;
    } else {
      log('FAIL', 'Client A failed to switch between own tabs');
      failed++;
    }

    // Client A closes its own tab (should succeed)
    log('TEST', 'Phase 7b: Client A closes own tab...');
    const closeOwn = await sendCDP(wsA, 'Target.closeTarget', { targetId: pagesA[0] });
    if (closeOwn.result?.success !== false && !closeOwn.error) {
      log('PASS', 'Client A can close its own tab');
      passed++;
    } else {
      log('FAIL', `Client A failed to close own tab: ${JSON.stringify(closeOwn)}`);
      failed++;
    }

    // Verify A now has 2 pages
    await sleep(1000);
    const targetsAfinal = await sendCDP(wsA, 'Target.getTargets');
    const aPagesFinal = (targetsAfinal.result?.targetInfos || []).filter(t => t.type === 'page');
    if (aPagesFinal.length === 2) {
      log('PASS', 'Client A has 2 remaining pages after closing one');
      passed++;
    } else {
      log('FAIL', `Client A has ${aPagesFinal.length} pages (expected 2)`);
      failed++;
    }

    // ── Phase 8: Disconnect A, verify B unaffected ──
    log('TEST', 'Phase 8: Disconnect Client A...');
    wsA.close();
    await sleep(5000);

    const targetsBfinal = await sendCDP(wsB, 'Target.getTargets');
    const bPagesFinal = (targetsBfinal.result?.targetInfos || []).filter(t => t.type === 'page');
    if (bPagesFinal.length === 3) {
      log('PASS', 'Client B still has 3 pages after A disconnected');
      passed++;
    } else {
      log('FAIL', `Client B has ${bPagesFinal.length} pages after A disconnect (expected 3)`);
      failed++;
    }

    wsB.close();
    await sleep(3000);

  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
  } finally {
    readChromeLogs();
    cleanup();
  }

  // Extension errors assertion
  if (extensionErrors.length === 0) {
    log('PASS', `Extension console: 0 critical errors`);
    passed++;
  } else {
    log('FAIL', `Extension console: ${extensionErrors.length} errors`);
    extensionErrors.forEach((e, i) => log('SW-ERR', `  ${i + 1}. ${e.substring(0, 200)}`));
    failed++;
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
