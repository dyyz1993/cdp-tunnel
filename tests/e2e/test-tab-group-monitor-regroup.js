#!/usr/bin/env node
'use strict';

/**
 * Test: Tab group monitor re-groups escaped tabs
 *
 * Scenario:
 * 1. CDP client creates a tab → verify it gets grouped (PASS 1)
 * 2. Force ungroup via Tab.ungroup → verify success (PASS 2)
 * 3. Wait for monitor to re-group (8s, monitor runs every 5s)
 * 4. Verify tab is re-grouped (PASS 3 — key assertion)
 * 5. Verify target still exists (PASS 4)
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
  console.log(`\n=== Test: Tab Group Monitor Re-group (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');
    log('SETUP', 'Proxy ready');

    profile = `/tmp/cdp-regroup-test-${Date.now()}`;
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

    // ── Step 1: Connect CDP client and create tab ──
    log('CDP', 'Connecting CDP client...');
    const ws = await connectCDP(PORT);
    log('CDP', 'Connected');

    log('CDP', 'Creating tab via Target.createTarget...');
    const createResult = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
    const targetId = createResult?.result?.targetId;
    log('CDP', `Created tab targetId: ${targetId}`);

    if (!targetId) throw new Error('No targetId returned from Target.createTarget');

    // ── Step 2: Verify grouped (PASS 1) ──
    log('WAIT', 'Waiting 3s for group assignment...');
    await sleep(3000);

    log('CHECK', 'Querying Tab.getGroupInfo...');
    const groupResult1 = await sendCDP(ws, 'Tab.getGroupInfo');
    const groupId1 = groupResult1?.result?.groupId;
    const cachedGroupId1 = groupResult1?.result?.cachedGroupId;
    const checkedTabId1 = groupResult1?.result?.tabId;
    log('CHECK', `groupId=${groupId1}, cachedGroupId=${cachedGroupId1}, tabId=${checkedTabId1}`);

    if (groupId1 != null && groupId1 > -1) {
      log('PASS', `1/4: Tab is grouped in Chrome (real groupId=${groupId1}, cached=${cachedGroupId1})`);
      passed++;
    } else {
      log('FAIL', `1/4: Tab is NOT grouped in Chrome (real groupId=${groupId1}, cached=${cachedGroupId1})`);
      failed++;
    }

    // ── Step 3: Force escape via Tab.ungroup (PASS 2) ──
    log('TEST', 'Calling Tab.ungroup to force escape...');
    const ungroupResult = await sendCDP(ws, 'Tab.ungroup');
    const ungroupSuccess = ungroupResult?.result?.success;
    const ungroupedCount = ungroupResult?.result?.ungroupedCount;
    log('TEST', `Tab.ungroup result: success=${ungroupSuccess}, ungroupedCount=${ungroupedCount}`);

    if (ungroupSuccess && ungroupedCount > 0) {
      log('PASS', `2/4: Tab ungrouped successfully (${ungroupedCount} tabs removed from group)`);
      passed++;
    } else {
      log('FAIL', `2/4: Tab.ungroup failed or no tabs ungrouped (success=${ungroupSuccess}, count=${ungroupedCount})`);
      failed++;
    }

    // ── Step 4: Wait for monitor to re-group ──
    log('WAIT', 'Waiting 8s for monitor to re-group (monitor interval: 5s)...');
    await sleep(8000);

    // ── Step 5: Verify re-grouped (PASS 3 — key assertion) ──
    log('CHECK', 'Querying Tab.getGroupInfo after monitor cycle...');
    const groupResult2 = await sendCDP(ws, 'Tab.getGroupInfo');
    const groupId2 = groupResult2?.result?.groupId;
    const cachedGroupId2 = groupResult2?.result?.cachedGroupId;
    const checkedTabId2 = groupResult2?.result?.tabId;
    log('CHECK', `groupId after regroup=${groupId2}, cachedGroupId=${cachedGroupId2}, tabId=${checkedTabId2}`);

    if (groupId2 != null && groupId2 > -1) {
      log('PASS', `3/4: Tab re-grouped by monitor in Chrome (real groupId=${groupId2}, cached=${cachedGroupId2})`);
      passed++;
    } else {
      log('FAIL', `3/4: Tab NOT re-grouped by monitor (real groupId=${groupId2}, cached=${cachedGroupId2})`);
      failed++;
    }

    // ── Step 6: Verify target still exists (PASS 4) ──
    log('CHECK', 'Querying Target.getTargets...');
    const targetsResult = await sendCDP(ws, 'Target.getTargets');
    const targetInfos = targetsResult?.result?.targetInfos || [];
    const stillExists = targetInfos.some(t => t.targetId === targetId);
    log('CHECK', `Target ${targetId} still exists: ${stillExists}`);

    if (stillExists) {
      log('PASS', '4/4: Target still exists after regroup');
      passed++;
    } else {
      log('FAIL', `4/4: Target ${targetId} no longer exists`);
      failed++;
    }

    // ── Teardown ──
    log('TEARDOWN', 'Closing CDP client...');
    ws.close();
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
