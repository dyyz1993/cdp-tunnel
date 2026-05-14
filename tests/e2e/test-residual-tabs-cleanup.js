#!/usr/bin/env node
'use strict';

/**
 * Test: CDP disconnect cleanup — do residual tabs get grouped incorrectly?
 *
 * Scenario:
 * 1. CDP client A connects, creates a tab (via Target.createTarget)
 * 2. Simulate a child tab from that CDP tab (via Tab.simulateUserOpen)
 * 3. Verify both tabs are in CDP group
 * 4. CDP client A force-terminates (simulate crash/heartbeat timeout)
 * 5. Wait for cleanup
 * 6. Verify: no residual CDP tabs survive (all should be closed)
 * 7. Connect CDP client B
 * 8. Verify: client B sees 0 pages (clean state, no orphans)
 *
 * Expected: all CDP-created and CDP-child tabs should be cleaned on disconnect.
 * If any survive, they could cause user's new tabs to be incorrectly grouped later.
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

async function waitForExtension(port) {
  await sleep(6000);
  for (let i = 0; i < 25; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
      const r = await Promise.race([sendCDP(ws, 'Target.getTargets'), new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 8000))]);
      ws.close(); _reqId = 0;
      if (r?.result?.targetInfos?.length > 0) return true;
    } catch (e) { log('SETUP', `Waiting for extension... (${e.message})`); }
    await sleep(3000);
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

async function runTest() {
  console.log(`\n=== Test: CDP Disconnect Cleanup — Residual Tabs (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');
    log('SETUP', 'Proxy ready');

    profile = `/tmp/cdp-residual-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
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

    // ── Phase 1: Client A creates tab + child tab ──
    log('A', 'Connecting Client A...');
    const wsA = await connectCDP(PORT);
    await sendCDP(wsA, 'Target.setDiscoverTargets', { discover: true });

    log('A', 'Creating CDP tab...');
    const r1 = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const targetId1 = r1.result.targetId;
    log('A', `CDP tab created: ${targetId1.substring(0, 12)}...`);

    await sleep(3000);

    // Verify CDP tab is grouped
    const g1 = await sendCDP(wsA, 'Tab.getGroupInfo');
    log('A', `CDP tab groupId=${g1.result?.groupId}`);
    if (g1.result?.groupId > -1) {
      log('PASS', '1. CDP tab is grouped');
      passed++;
    } else {
      log('FAIL', '1. CDP tab is NOT grouped');
      failed++;
    }

    // Create child tab via simulateUserOpen
    log('A', 'Creating child tab via simulateUserOpen...');
    const sim = await sendCDP(wsA, 'Tab.simulateUserOpen');
    log('A', `simulateUserOpen: ${JSON.stringify(sim.result)}`);

    if (sim.result?.success) {
      log('PASS', '2. Child tab created');
      passed++;
    } else {
      log('FAIL', '2. Child tab creation failed');
      failed++;
    }

    const childTabId = sim.result?.newTabId;
    await sleep(3000);

    // Check child tab group status
    if (childTabId) {
      const childGroup = await sendCDP(wsA, 'Tab.getTabGroup', { tabId: childTabId });
      log('A', `Child tab groupId=${childGroup.result?.groupId}`);
      log('INFO', `Child tab status: ${JSON.stringify(childGroup.result)}`);
    }

    // Check total pages visible to Client A
    const targetsA = await sendCDP(wsA, 'Target.getTargets');
    const pagesA = (targetsA.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    log('A', `Client A sees ${pagesA.length} pages`);

    // ── Phase 2: Client A force-terminates ──
    log('TEST', 'Phase 2: Force-terminating Client A...');
    wsA.terminate();

    log('TEST', 'Waiting 10s for cleanup...');
    await sleep(10000);

    // ── Phase 3: Client B checks for residual tabs ──
    log('B', 'Connecting Client B...');
    const wsB = await connectCDP(PORT);
    await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const targetsB = await sendCDP(wsB, 'Target.getTargets');
    const pagesB = (targetsB.result?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));

    log('B', `Client B sees ${pagesB.length} pages`);
    pagesB.forEach(t => log('B', `  residual: targetId=${t.targetId.substring(0, 12)} url=${t.url}`));

    if (pagesB.length === 0) {
      log('PASS', '3. No residual pages after Client A disconnect');
      passed++;
    } else {
      log('FAIL', `3. ${pagesB.length} residual pages survived disconnect!`);
      failed++;
    }

    // ── Phase 4: Check child tab specifically ──
    if (childTabId) {
      const childCheck = await sendCDP(wsB, 'Tab.getTabGroup', { tabId: childTabId });
      if (childCheck.error || childCheck.result?.error) {
        log('PASS', '4. Child tab no longer exists (getTabGroup failed = tab was closed)');
        passed++;
      } else {
        log('CHECK', `Child tab still exists: groupId=${childCheck.result?.groupId}, url=${childCheck.result?.url}`);
        if (childCheck.result?.groupId === -1) {
          log('PASS', '4. Child tab survived but is ungrouped (acceptable)');
          passed++;
        } else {
          log('FAIL', `4. Child tab survived AND is in group ${childCheck.result?.groupId}!`);
          failed++;
        }
      }
    }

    wsB.close();
    await sleep(2000);

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
