#!/usr/bin/env node
'use strict';

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
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`Timeout: ${method}`)); }, 20000);
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

async function waitForExtension(port, maxWait = 90000) {
  const start = Date.now();
  await sleep(6000);
  while (Date.now() - start < maxWait) {
    try {
      const list = await httpGet(port, '/json/list');
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
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function setup() {
  patchConfig(PORT);

  proxyProcess = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (!await waitForProxy(PORT)) throw new Error('Proxy failed to start');
  log('SETUP', 'Proxy ready');

  profile = `/tmp/cdp-group-fix-test-${Date.now()}`;
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

  if (!await waitForExtension(PORT)) throw new Error('Extension failed to connect');
  log('SETUP', 'Extension connected');
}

async function runTest() {
  console.log(`\n=== Test: Group Fixes (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    await setup();

    // ═══════════════════════════════════════════
    // Test Group A: Unique group names / isolation
    // ═══════════════════════════════════════════
    log('GROUP-A', '--- Test A: Unique group names & client isolation ---');

    log('A', 'Connecting Client A...');
    const wsA = await connectCDP(PORT);
    await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });

    log('A', 'Creating 2 pages...');
    const rA1 = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const rA2 = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const pageA1 = rA1.result?.targetId;
    const pageA2 = rA2.result?.targetId;
    log('A', `Created: ${pageA1?.substring(0,12)}, ${pageA2?.substring(0,12)}`);

    await sleep(3000);

    const targetsA = await sendCDP(wsA, 'Target.getTargets');
    const aPages = (targetsA.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    log('A', `Sees ${aPages.length} pages`);

    if (aPages.length >= 2) {
      log('PASS', `A.1: Client A sees ${aPages.length} pages (>= 2 expected)`);
      passed++;
    } else {
      log('FAIL', `A.1: Client A sees ${aPages.length} pages (expected >= 2)`);
      failed++;
    }

    log('B', 'Connecting Client B...');
    const wsB = await connectCDP(PORT);
    await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });

    log('B', 'Creating 2 pages...');
    const rB1 = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
    const rB2 = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
    const pageB1 = rB1.result?.targetId;
    const pageB2 = rB2.result?.targetId;
    log('B', `Created: ${pageB1?.substring(0,12)}, ${pageB2?.substring(0,12)}`);

    await sleep(3000);

    const targetsB = await sendCDP(wsB, 'Target.getTargets');
    const bPages = (targetsB.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    log('B', `Sees ${bPages.length} pages`);

    const bOwnPages = bPages.filter(t => t.targetId === pageB1 || t.targetId === pageB2);
    const bSeesAPages = bPages.filter(t => t.targetId === pageA1 || t.targetId === pageA2);

    if (bOwnPages.length === 2 && bSeesAPages.length === 0) {
      log('PASS', `A.2: Client B sees only its own ${bOwnPages.length} pages, 0 from Client A`);
      passed++;
    } else {
      log('FAIL', `A.2: Client B own=${bOwnPages.length}/2, A's pages=${bSeesAPages.length}/0`);
      failed++;
    }

    const targetsA2 = await sendCDP(wsA, 'Target.getTargets');
    const a2Pages = (targetsA2.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    const aOwnPages = a2Pages.filter(t => t.targetId === pageA1 || t.targetId === pageA2);
    const aSeesBPages = a2Pages.filter(t => t.targetId === pageB1 || t.targetId === pageB2);

    if (aOwnPages.length === 2 && aSeesBPages.length === 0) {
      log('PASS', `A.3: Client A still sees only its own ${aOwnPages.length} pages, 0 from Client B`);
      passed++;
    } else {
      log('FAIL', `A.3: Client A own=${aOwnPages.length}/2, B's pages=${aSeesBPages.length}/0`);
      failed++;
    }

    wsA.close();
    wsB.close();
    await sleep(5000);

    // ═══════════════════════════════════════════
    // Test Group B: No escaped pages (reliable grouping)
    // ═══════════════════════════════════════════
    log('GROUP-B', '--- Test B: No escaped pages (reliable grouping) ---');

    const listBefore = await httpGet(PORT, '/json/list');
    const baselineTabs = (listBefore || []).filter(t => t.type === 'page').length;
    log('B-PRE', `Baseline browser tabs: ${baselineTabs}`);

    const wsC = await connectCDP(PORT);
    await sendCDP(wsC, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const listAfterConnect = await httpGet(PORT, '/json/list');
    const afterConnectTabs = (listAfterConnect || []).filter(t => t.type === 'page').length;
    log('B-PRE', `After connect tabs: ${afterConnectTabs}`);

    log('B', 'Creating 5 pages in rapid succession...');
    const rapidPromises = [];
    for (let i = 0; i < 5; i++) {
      rapidPromises.push(sendCDP(wsC, 'Target.createTarget', { url: 'about:blank' }));
    }
    const rapidResults = await Promise.all(rapidPromises);
    const rapidTargetIds = rapidResults.map(r => r.result?.targetId).filter(Boolean);
    log('B', `Created ${rapidTargetIds.length} pages: ${rapidTargetIds.map(t => t.substring(0, 8)).join(', ')}`);

    log('B', 'Waiting 3 seconds for grouping to settle...');
    await sleep(3000);

    const targetsC = await sendCDP(wsC, 'Target.getTargets');
    const cPages = (targetsC.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    log('B', `Target.getTargets: ${cPages.length} pages`);

    const cOwnedPages = cPages.filter(t => rapidTargetIds.includes(t.targetId));
    log('B', `Owned by this client: ${cOwnedPages.length}/${rapidTargetIds.length} created pages`);

    const expectedCdpPages = rapidTargetIds.length;
    if (cOwnedPages.length === expectedCdpPages) {
      log('PASS', `B.1: All ${cOwnedPages.length} created pages are owned by this client (no escaped pages)`);
      passed++;
    } else {
      log('FAIL', `B.1: Only ${cOwnedPages.length}/${expectedCdpPages} created pages are owned (${expectedCdpPages - cOwnedPages.length} escaped)`);
      failed++;
    }

    const listAfterCreate = await httpGet(PORT, '/json/list');
    const afterCreateTabs = (listAfterCreate || []).filter(t => t.type === 'page').length;
    const newTabs = afterCreateTabs - afterConnectTabs;
    log('B', `Browser tabs: ${afterCreateTabs} total, ${newTabs} new (expected ~${expectedCdpPages})`);

    if (newTabs >= expectedCdpPages && newTabs <= expectedCdpPages + 1) {
      log('PASS', `B.2: Browser tab count correct: ${newTabs} new tabs (${expectedCdpPages} expected)`);
      passed++;
    } else {
      log('FAIL', `B.2: Browser tab count off: ${newTabs} new tabs (${expectedCdpPages} expected, range ${expectedCdpPages}-${expectedCdpPages + 1})`);
      failed++;
    }

    wsC.close();
    await sleep(5000);

    // ═══════════════════════════════════════════
    // Test Group C: Clean group cleanup on disconnect
    // ═══════════════════════════════════════════
    log('GROUP-C', '--- Test C: Clean group cleanup on disconnect ---');

    const listBaseline = await httpGet(PORT, '/json/list');
    const baselineCTabs = (listBaseline || []).filter(t => t.type === 'page').length;
    log('C', `Baseline browser tabs: ${baselineCTabs}`);

    const wsD = await connectCDP(PORT);
    await sendCDP(wsD, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const listAfterDConnect = await httpGet(PORT, '/json/list');
    const afterDConnectTabs = (listAfterDConnect || []).filter(t => t.type === 'page').length;
    log('C', `After D connect tabs: ${afterDConnectTabs} (auto-default page created)`);

    log('C', 'Client D: creating 3 pages...');
    const rD1 = await sendCDP(wsD, 'Target.createTarget', { url: 'about:blank' });
    const rD2 = await sendCDP(wsD, 'Target.createTarget', { url: 'about:blank' });
    const rD3 = await sendCDP(wsD, 'Target.createTarget', { url: 'about:blank' });
    const pageD1 = rD1.result?.targetId;
    const pageD2 = rD2.result?.targetId;
    const pageD3 = rD3.result?.targetId;
    log('C', `Created: ${[pageD1, pageD2, pageD3].map(t => t?.substring(0,8)).join(', ')}`);

    await sleep(3000);

    const listAfterCreateD = await httpGet(PORT, '/json/list');
    const afterCreateDTabs = (listAfterCreateD || []).filter(t => t.type === 'page').length;
    const dNewTabs = afterCreateDTabs - afterDConnectTabs;
    log('C', `After creating 3 pages: ${afterCreateDTabs} tabs, ${dNewTabs} new`);

    if (dNewTabs >= 3 && dNewTabs <= 4) {
      log('PASS', `C.1: Tab count increased by ${dNewTabs} after creating 3 pages (expected 3-4)`);
      passed++;
    } else {
      log('FAIL', `C.1: Tab count increased by ${dNewTabs} after creating 3 pages (expected 3-4)`);
      failed++;
    }

    log('C', 'Disconnecting Client D...');
    wsD.terminate();

    log('C', 'Waiting 8 seconds for cleanup...');
    await sleep(8000);

    const listAfterCleanup = await httpGet(PORT, '/json/list');
    const afterCleanupTabs = (listAfterCleanup || []).filter(t => t.type === 'page').length;
    log('C', `After cleanup tabs: ${afterCleanupTabs} (baseline was ${baselineCTabs})`);

    const tabDiff = Math.abs(afterCleanupTabs - baselineCTabs);
    if (tabDiff <= 1) {
      log('PASS', `C.2: Tab count returned to baseline (${afterCleanupTabs} vs ${baselineCTabs}, diff=${tabDiff})`);
      passed++;
    } else {
      log('FAIL', `C.2: Tab count NOT at baseline (${afterCleanupTabs} vs ${baselineCTabs}, diff=${tabDiff})`);
      failed++;
    }

    log('C', 'Connecting Client E to verify no leftover pages...');
    const wsE = await connectCDP(PORT);
    await sendCDP(wsE, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const targetsE = await sendCDP(wsE, 'Target.getTargets');
    const ePages = (targetsE.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    log('C', `Client E sees ${ePages.length} pages`);

    const eLeftoverPages = ePages.filter(t => t.targetId === pageD1 || t.targetId === pageD2 || t.targetId === pageD3);
    if (eLeftoverPages.length === 0) {
      log('PASS', `C.3: Client E sees 0 leftover pages from Client D`);
      passed++;
    } else {
      log('FAIL', `C.3: Client E sees ${eLeftoverPages.length} leftover pages from Client D`);
      failed++;
    }

    wsE.close();
    await sleep(2000);

  } catch (err) {
    console.error('\nFATAL:', err.message, err.stack);
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
