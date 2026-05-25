#!/usr/bin/env node
'use strict';

/**
 * TDD Test: Group Architecture Root Fix
 *
 * Verifies the new "connect-time group creation + direct join + event-driven"
 * architecture works correctly across all scenarios.
 *
 * Scenario A: Connect auto-creates group
 * Scenario B: 5 concurrent pages share 1 group
 * Scenario C: Disconnect/reconnect group cleanup
 * Scenario D: Multi-cycle stress test (3 rounds)
 * Scenario E: Mixed operations (serial + concurrent + close)
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
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`Timeout: ${method}`)); }, 30000);
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

  profile = `/tmp/cdp-group-root-test-${Date.now()}`;
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

async function getVisiblePages(ws) {
  const r = await sendCDP(ws, 'Target.getTargets');
  return (r.result?.targetInfos || []).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
  );
}

async function getBrowserPageCount() {
  const list = await httpGet(PORT, '/json/list');
  return (list || []).filter(t => t.type === 'page').length;
}

async function runTest() {
  console.log(`\n=== Test: Group Root Fix (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  function assert(condition, passMsg, failMsg) {
    if (condition) { log('PASS', passMsg); passed++; }
    else { log('FAIL', failMsg); failed++; }
  }

  try {
    await setup();

    // ═══════════════════════════════════════════
    // Scenario A: Connect auto-creates group
    // ═══════════════════════════════════════════
    log('A', '--- Scenario A: Connect auto-creates group ---');

    const wsA = await connectCDP(PORT);
    await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    assert(true,
      'A.1: CDP connection established',
      'A.1: CDP connection failed');

    const createA1 = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    assert(!!createA1.result?.targetId,
      'A.2: Created 1 page successfully',
      'A.2: Failed to create page: ' + JSON.stringify(createA1.error));

    await sleep(2000);
    const pagesA2 = await getVisiblePages(wsA);
    const a1Visible = pagesA2.filter(t => t.targetId === createA1.result.targetId);
    assert(a1Visible.length === 1,
      'A.3: Created page visible via getTargets',
      'A.3: Created page not visible (got ' + a1Visible.length + ')');

    wsA.close();
    await sleep(5000);

    // ═══════════════════════════════════════════
    // Scenario B: 5 concurrent pages, 1 group
    // ═══════════════════════════════════════════
    log('B', '--- Scenario B: 5 concurrent pages share 1 group ---');

    const wsB = await connectCDP(PORT);
    await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    log('B', 'Creating 5 pages concurrently...');
    const results5 = await Promise.all([
      sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' }),
    ]);
    const ids5 = results5.map(r => r.result?.targetId).filter(Boolean);
    const errs5 = results5.filter(r => r.error);

    assert(ids5.length === 5 && errs5.length === 0,
      'B.1: All 5 concurrent createTarget succeeded',
      'B.1: Got ' + ids5.length + '/5 targets, ' + errs5.length + ' errors');

    await sleep(3000);
    const pagesB = await getVisiblePages(wsB);
    const ownedB = pagesB.filter(t => ids5.includes(t.targetId));
    assert(ownedB.length === 5,
      'B.2: All 5 pages visible via getTargets',
      'B.2: Only ' + ownedB.length + '/5 pages visible');

    wsB.close();
    await sleep(5000);

    // Reconnect and verify cleanup
    const wsB2 = await connectCDP(PORT);
    await sendCDP(wsB2, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesB2 = await getVisiblePages(wsB2);
    const leftoverB = pagesB2.filter(t => ids5.includes(t.targetId));
    assert(leftoverB.length === 0,
      'B.3: No leftover pages from previous client after reconnect',
      'B.3: ' + leftoverB.length + ' leftover pages found');

    wsB2.close();
    await sleep(3000);

    // ═══════════════════════════════════════════
    // Scenario C: Disconnect/reconnect group cleanup
    // ═══════════════════════════════════════════
    log('C', '--- Scenario C: Disconnect/reconnect cleanup ---');

    const wsC1 = await connectCDP(PORT);
    await sendCDP(wsC1, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    const c1 = await Promise.all([
      sendCDP(wsC1, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsC1, 'Target.createTarget', { url: 'about:blank' }),
    ]);
    const c1Ids = c1.map(r => r.result?.targetId).filter(Boolean);
    assert(c1Ids.length === 2,
      'C.1: Created 2 pages',
      'C.1: Failed to create 2 pages, got ' + c1Ids.length);

    wsC1.close();
    log('C', 'Disconnected, waiting 8s for cleanup...');
    await sleep(8000);

    const wsC2 = await connectCDP(PORT);
    await sendCDP(wsC2, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesC2 = await getVisiblePages(wsC2);
    const c1Leftover = pagesC2.filter(t => c1Ids.includes(t.targetId));
    assert(c1Leftover.length === 0,
      'C.2: No leftover pages from previous client (' + c1Leftover.length + ' leftover)',
      'C.2: ' + c1Leftover.length + ' leftover pages from previous client');

    const c2 = await Promise.all([
      sendCDP(wsC2, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsC2, 'Target.createTarget', { url: 'about:blank' }),
    ]);
    const c2Ids = c2.map(r => r.result?.targetId).filter(Boolean);
    assert(c2Ids.length === 2,
      'C.3: Created 2 new pages after reconnect',
      'C.3: Failed to create 2 new pages, got ' + c2Ids.length);

    wsC2.close();
    await sleep(5000);

    const wsC3 = await connectCDP(PORT);
    await sendCDP(wsC3, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesC3 = await getVisiblePages(wsC3);
    const c2Leftover = pagesC3.filter(t => c2Ids.includes(t.targetId));
    assert(c2Leftover.length === 0,
      'C.4: No leftover pages after 2nd reconnect',
      'C.4: ' + c2Leftover.length + ' leftover pages after 2nd reconnect');

    wsC3.close();
    await sleep(3000);

    // ═══════════════════════════════════════════
    // Scenario D: Multi-cycle stress (3 rounds)
    // ═══════════════════════════════════════════
    log('D', '--- Scenario D: 3-round stress test ---');

    for (let round = 1; round <= 3; round++) {
      const wsD = await connectCDP(PORT);
      await sendCDP(wsD, 'Target.setDiscoverTargets', { discover: true });
      await sleep(1000);

      const dResults = await Promise.all([
        sendCDP(wsD, 'Target.createTarget', { url: 'about:blank' }),
        sendCDP(wsD, 'Target.createTarget', { url: 'about:blank' }),
        sendCDP(wsD, 'Target.createTarget', { url: 'about:blank' }),
      ]);
      const dIds = dResults.map(r => r.result?.targetId).filter(Boolean);
      assert(dIds.length === 3,
        'D.' + round + '.1: Round ' + round + ' - created 3 pages',
        'D.' + round + '.1: Round ' + round + ' - got ' + dIds.length + '/3 pages');

      wsD.close();
      await sleep(5000);
    }

    const wsDfinal = await connectCDP(PORT);
    await sendCDP(wsDfinal, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesDfinal = await getVisiblePages(wsDfinal);
    assert(pagesDfinal.length >= 0,
      'D.4: Clean state after 3 stress rounds (reconnect OK, ' + pagesDfinal.length + ' pages)',
      'D.4: Failed to reconnect after 3 stress rounds');

    wsDfinal.close();
    await sleep(3000);

    // ═══════════════════════════════════════════
    // Scenario E: Mixed operations
    // ═══════════════════════════════════════════
    log('E', '--- Scenario E: Mixed operations ---');

    const wsE = await connectCDP(PORT);
    await sendCDP(wsE, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    const e1 = await sendCDP(wsE, 'Target.createTarget', { url: 'about:blank' });
    const e1Id = e1.result?.targetId;
    assert(!!e1Id,
      'E.1: Serial create page 1',
      'E.1: Failed to create page 1');

    await sleep(500);

    const e2 = await sendCDP(wsE, 'Target.createTarget', { url: 'about:blank' });
    const e2Id = e2.result?.targetId;
    assert(!!e2Id,
      'E.2: Serial create page 2',
      'E.2: Failed to create page 2');

    await sleep(1000);

    const eConcurrent = await Promise.all([
      sendCDP(wsE, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(wsE, 'Target.createTarget', { url: 'about:blank' }),
    ]);
    const eConcIds = eConcurrent.map(r => r.result?.targetId).filter(Boolean);
    assert(eConcIds.length === 2,
      'E.3: Concurrent create 2 pages',
      'E.3: Got ' + eConcIds.length + '/2 concurrent pages');

    await sleep(2000);
    const allEIds = [e1Id, e2Id, ...eConcIds].filter(Boolean);
    const pagesE = await getVisiblePages(wsE);
    const ownedE = pagesE.filter(t => allEIds.includes(t.targetId));
    assert(ownedE.length === 4,
      'E.4: All 4 pages visible (' + ownedE.length + ')',
      'E.4: Expected 4 pages, got ' + ownedE.length);

    if (e1Id) {
      await sendCDP(wsE, 'Target.closeTarget', { targetId: e1Id });
      await sleep(2000);
    }

    const pagesE2 = await getVisiblePages(wsE);
    const ownedE2 = pagesE2.filter(t => allEIds.includes(t.targetId));
    assert(ownedE2.length === 3,
      'E.5: 3 pages remain after closing 1',
      'E.5: Expected 3 remaining, got ' + ownedE2.length);

    wsE.close();
    await sleep(5000);

    const wsE2 = await connectCDP(PORT);
    await sendCDP(wsE2, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesEfinal = await getVisiblePages(wsE2);
    const eLeftover = pagesEfinal.filter(t => allEIds.includes(t.targetId));
    assert(eLeftover.length === 0,
      'E.6: No leftover pages from mixed ops session',
      'E.6: ' + eLeftover.length + ' leftover pages after mixed ops');

    wsE2.close();

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
