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

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

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
  for (let i = 0; i < 20; i++) { try { const r = await new Promise((resolve, reject) => { http.get(`http://localhost:${port}/json/version`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }).on('error', reject); }); if (r) return true; } catch {} await sleep(500); }
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

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: Multi-Tab Rapid Group Creation (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;
  const TAB_COUNT = 5;
  const tabTargetIds = [];

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-multi-tab-group-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    // 1. Connect one CDP client
    log('CDP', 'Connecting CDP client...');
    const ws = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    log('CDP', 'Connected');

    // 2. Rapidly create 5 tabs (no await sleep between them)
    log('CDP', `Rapidly creating ${TAB_COUNT} tabs...`);
    for (let i = 0; i < TAB_COUNT; i++) {
      const createResult = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
      const tid = createResult?.result?.targetId;
      if (tid) {
        tabTargetIds.push(tid);
        log('CDP', `Tab ${i + 1}/${TAB_COUNT} created: ${tid}`);
      } else {
        log('FAIL', `Tab ${i + 1}/${TAB_COUNT} creation failed: ${JSON.stringify(createResult)}`);
        failed++;
      }
    }
    log('CDP', `Created ${tabTargetIds.length}/${TAB_COUNT} tabs`);

    if (tabTargetIds.length === 0) {
      log('FAIL', 'No tabs created at all, aborting');
      failed++;
      ws.close();
      cleanup();
      console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
      process.exit(1);
      return;
    }

    // 3. Wait 5 seconds for group assignment
    log('WAIT', 'Waiting 5s for group assignment...');
    await sleep(5000);

    // 4. Check each tab's group info
    log('CHECK', '--- First check (5s) ---');
    let grouped5s = 0;
    let notGrouped5s = 0;
    for (let i = 0; i < tabTargetIds.length; i++) {
      const tid = tabTargetIds[i];
      const groupResult = await sendCDP(ws, 'Tab.getGroupInfo', { targetId: tid });
      const { groupId, baseName, clientId } = groupResult?.result || {};
      const isGrouped = groupId != null && groupId > -1;
      if (isGrouped) {
        grouped5s++;
        log('CHECK', `Tab ${i + 1} (${tid.slice(0, 8)}): GROUPED (groupId=${groupId}, baseName=${baseName})`);
      } else {
        notGrouped5s++;
        log('CHECK', `Tab ${i + 1} (${tid.slice(0, 8)}): NOT GROUPED (groupId=${groupId}, clientId=${clientId})`);
      }
    }
    log('TALLY', `After 5s: ${grouped5s}/${TAB_COUNT} grouped, ${notGrouped5s}/${TAB_COUNT} not grouped`);

    // 5. Wait another 8 seconds (let monitor run) and re-check
    log('WAIT', 'Waiting another 8s for monitor cycle...');
    await sleep(8000);

    log('CHECK', '--- Final check (13s total) ---');
    let groupedFinal = 0;
    let notGroupedFinal = 0;
    for (let i = 0; i < tabTargetIds.length; i++) {
      const tid = tabTargetIds[i];
      const groupResult = await sendCDP(ws, 'Tab.getGroupInfo', { targetId: tid });
      const { groupId, baseName, clientId } = groupResult?.result || {};
      const isGrouped = groupId != null && groupId > -1;
      if (isGrouped) {
        groupedFinal++;
        log('CHECK', `Tab ${i + 1} (${tid.slice(0, 8)}): GROUPED (groupId=${groupId}, baseName=${baseName})`);
      } else {
        notGroupedFinal++;
        log('CHECK', `Tab ${i + 1} (${tid.slice(0, 8)}): NOT GROUPED (groupId=${groupId}, clientId=${clientId})`);
      }
    }
    log('TALLY', `Final (13s): ${groupedFinal}/${TAB_COUNT} grouped, ${notGroupedFinal}/${TAB_COUNT} not grouped`);

    // 6. Report
    console.log('\n=== SUMMARY ===');
    console.log(`First check (5s):  ${grouped5s}/${TAB_COUNT} grouped, ${notGrouped5s}/${TAB_COUNT} not grouped`);
    console.log(`Final check (13s): ${groupedFinal}/${TAB_COUNT} grouped, ${notGroupedFinal}/${TAB_COUNT} not grouped`);

    if (groupedFinal === TAB_COUNT) {
      log('PASS', `All ${TAB_COUNT} tabs successfully grouped`);
      passed++;
    } else if (groupedFinal > 0) {
      log('PARTIAL', `${groupedFinal}/${TAB_COUNT} tabs grouped (partial)`);
      passed++;
    } else {
      log('FAIL', `No tabs were grouped out of ${TAB_COUNT}`);
      failed++;
    }

    // 7. Disconnect
    log('DISC', 'Disconnecting...');
    ws.close();
    await sleep(1000);

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
