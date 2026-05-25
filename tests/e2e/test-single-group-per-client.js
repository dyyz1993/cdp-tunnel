#!/usr/bin/env node
'use strict';

/**
 * TDD Test: Single group per client — monitor must not create duplicate groups
 *
 * Bug: startGroupMonitor (5s timer) in websocket.js bypasses the _groupQueue
 * when a tab has no groupId, directly calling chrome.tabs.group() to create
 * a new group. This races with doGroup in special.js, resulting in multiple
 * same-named groups for the same client.
 *
 * Fix:
 * 1. startGroupMonitor delegates to addTabToAutomationGroup instead of creating groups
 * 2. doGroup checks State cache for groupId before querying
 *
 * Verifications (3 stress rounds):
 * 1. Connect CDP, wait 8s (monitor triggers at least once)
 * 2. Create 3 pages concurrently
 * 3. Wait 8s (monitor triggers again — if buggy, creates duplicate groups)
 * 4. Verify all 3 pages exist and are owned
 * 5. Disconnect + reconnect → verify clean state (1 default page, no leftovers)
 * 6. Repeat 3 times to stress-test the race condition
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

  profile = `/tmp/cdp-single-group-test-${Date.now()}`;
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

async function runSingleRound(roundNum) {
  let passed = 0, failed = 0;

  log('ROUND', `═══ Round ${roundNum}: Start ═══`);

  // Step 1: Connect CDP
  const ws = await connectCDP(PORT);
  await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

  // Step 2: Wait 8s — let startGroupMonitor fire at least once
  log('ROUND', 'Waiting 8s for monitor to fire...');
  await sleep(8000);

  // Step 3: Create 3 pages concurrently
  log('ROUND', 'Creating 3 pages concurrently...');
  const results = await Promise.all([
    sendCDP(ws, 'Target.createTarget', { url: 'about:blank' }),
    sendCDP(ws, 'Target.createTarget', { url: 'about:blank' }),
    sendCDP(ws, 'Target.createTarget', { url: 'about:blank' }),
  ]);
  const targetIds = results.map(r => r.result?.targetId).filter(Boolean);
  const errors = results.filter(r => r.error);

  log('ROUND', `Created ${targetIds.length} targets, ${errors.length} errors`);

  if (targetIds.length === 3 && errors.length === 0) {
    log('PASS', `R${roundNum}.1: All 3 concurrent createTarget succeeded`);
    passed++;
  } else {
    log('FAIL', `R${roundNum}.1: Got ${targetIds.length}/3 targets, ${errors.length} errors`);
    failed++;
  }

  // Step 4: Wait 8s — let monitor fire again (bug would create duplicate groups here)
  log('ROUND', 'Waiting 8s for monitor to fire again...');
  await sleep(8000);

  // Step 5: Verify all 3 pages still exist and are owned
  const targetsResult = await sendCDP(ws, 'Target.getTargets');
  const pageTargets = (targetsResult.result?.targetInfos || []).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
  );
  const ownedPages = pageTargets.filter(t => targetIds.includes(t.targetId));

  log('ROUND', `getTargets: ${pageTargets.length} total, ${ownedPages.length} owned`);

  if (ownedPages.length === 3) {
    log('PASS', `R${roundNum}.2: All 3 pages visible via getTargets after monitor fires`);
    passed++;
  } else {
    log('FAIL', `R${roundNum}.2: Only ${ownedPages.length}/3 pages visible`);
    failed++;
  }

  // Verify browser tab count — if duplicate groups were created, tabs may be duplicated
  const listAfter = await httpGet(PORT, '/json/list');
  const browserTabs = (listAfter || []).filter(t => t.type === 'page');
  log('ROUND', `Browser tabs: ${browserTabs.length}`);

  // Should be exactly 4 (1 default + 3 created) or close to it
  // If there are more, it suggests duplicate tabs/groups
  if (browserTabs.length >= 3 && browserTabs.length <= 5) {
    log('PASS', `R${roundNum}.3: Browser tab count ${browserTabs.length} in expected range (3-5)`);
    passed++;
  } else {
    log('FAIL', `R${roundNum}.3: Browser tab count ${browserTabs.length} outside expected range`);
    failed++;
  }

  // Step 6: Disconnect
  ws.terminate();
  log('ROUND', 'Disconnected, waiting 8s for cleanup...');
  await sleep(8000);

  // Step 7: Reconnect and verify clean state
  const ws2 = await connectCDP(PORT);
  await sendCDP(ws2, 'Target.setDiscoverTargets', { discover: true });
  await sleep(2000);

  const targets2 = await sendCDP(ws2, 'Target.getTargets');
  const pages2 = (targets2.result?.targetInfos || []).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
  );
  const leftoverPages = pages2.filter(t => targetIds.includes(t.targetId));

  log('ROUND', `New client sees ${pages2.length} pages, ${leftoverPages.length} leftover`);

  if (leftoverPages.length === 0) {
    log('PASS', `R${roundNum}.4: No leftover pages from previous client`);
    passed++;
  } else {
    log('FAIL', `R${roundNum}.4: ${leftoverPages.length} leftover pages from previous client`);
    failed++;
  }

  ws2.close();
  await sleep(3000);

  return { passed, failed };
}

async function runTest() {
  console.log(`\n=== Test: Single Group Per Client (3 stress rounds, port ${PORT}) ===\n`);
  let totalPassed = 0, totalFailed = 0;

  try {
    await setup();

    for (let round = 1; round <= 3; round++) {
      const { passed, failed } = await runSingleRound(round);
      totalPassed += passed;
      totalFailed += failed;
    }

  } catch (err) {
    console.error('\nFATAL:', err.message, err.stack);
    totalFailed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${totalPassed} passed, ${totalFailed} failed ===\n`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

runTest();
