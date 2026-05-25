#!/usr/bin/env node
'use strict';

/**
 * TDD Test: Rapid Reconnect Group Race Condition
 *
 * Verifies that createGroupForClient's sync lock prevents duplicate
 * group creation when the same clientId reconnects rapidly.
 *
 * Scenario A: 5 rapid connect/disconnect cycles (1s gap)
 * Scenario B: 3 extreme rapid cycles (no gap)
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

async function getVisiblePages(ws) {
  const r = await sendCDP(ws, 'Target.getTargets');
  return (r.result?.targetInfos || []).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
  );
}

async function setup() {
  patchConfig(PORT);

  proxyProcess = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (!await waitForProxy(PORT)) throw new Error('Proxy failed to start');
  log('SETUP', 'Proxy ready');

  profile = `/tmp/cdp-group-race-test-${Date.now()}`;
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
  await sleep(3000);
}

async function runTest() {
  console.log(`\n=== Test: Rapid Reconnect Group Race (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  function assert(condition, passMsg, failMsg) {
    if (condition) { log('PASS', passMsg); passed++; }
    else { log('FAIL', failMsg); failed++; }
  }

  try {
    await setup();

    const baseline = await getVisiblePages(await connectCDP(PORT));
    const baselineWs = await connectCDP(PORT);
    await sendCDP(baselineWs, 'Target.setDiscoverTargets', { discover: true });
    const baselinePages = await getVisiblePages(baselineWs);
    const baselineCount = baselinePages.length;
    baselineWs.close();
    await sleep(3000);

    // ══════════════════════════════════════════════════════════════════
    // Scenario A: 5 rapid connect/disconnect cycles with page creation
    // ══════════════════════════════════════════════════════════════════
    log('A', '--- 5 rapid connect/disconnect cycles ---');

    for (let i = 0; i < 5; i++) {
      log('A', `Cycle ${i + 1}/5: connect...`);
      const ws = await connectCDP(PORT);
      await sendCDP(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
      await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

      await sleep(1000);

      const pagesAfterConnect = await getVisiblePages(ws);
      assert(pagesAfterConnect.length <= baselineCount + 1,
        `A.${i + 1}.1: Cycle ${i + 1} — reconnect has ≤${baselineCount + 1} default pages (got ${pagesAfterConnect.length})`,
        `A.${i + 1}.1: Cycle ${i + 1} — too many pages on reconnect (${pagesAfterConnect.length}, expected ≤${baselineCount + 1})`);

      const created = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
      assert(!!created.result?.targetId,
        `A.${i + 1}.2: Cycle ${i + 1} — created page OK`,
        `A.${i + 1}.2: Cycle ${i + 1} — failed to create page: ${JSON.stringify(created.error)}`);

      const created2 = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
      assert(!!created2.result?.targetId,
        `A.${i + 1}.3: Cycle ${i + 1} — created 2nd page OK`,
        `A.${i + 1}.3: Cycle ${i + 1} — failed to create 2nd page`);

      await sleep(1000);

      const pagesCheck = await getVisiblePages(ws);
      const ownCount = pagesCheck.filter(t =>
        t.targetId === created.result?.targetId || t.targetId === created2.result?.targetId
      ).length;
      assert(ownCount === 2,
        `A.${i + 1}.4: Cycle ${i + 1} — both pages visible (${ownCount}/2)`,
        `A.${i + 1}.4: Cycle ${i + 1} — pages missing (${ownCount}/2)`);

      log('A', `Cycle ${i + 1}: disconnect`);
      ws.terminate();
    }

    log('A', 'Waiting 8s for cleanup...');
    await sleep(8000);

    const wsVerifyA = await connectCDP(PORT);
    await sendCDP(wsVerifyA, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesFinalA = await getVisiblePages(wsVerifyA);
    assert(pagesFinalA.length <= baselineCount,
      `A.6: No leftover pages after 5 cycles (${pagesFinalA.length} pages, baseline ${baselineCount})`,
      `A.6: Leftover pages after 5 cycles (${pagesFinalA.length}, expected ≤${baselineCount})`);

    wsVerifyA.close();
    await sleep(5000);

    // ══════════════════════════════════════════════════════════════════
    // Scenario B: 3 extreme rapid cycles (no wait between disconnect/reconnect)
    // ══════════════════════════════════════════════════════════════════
    log('B', '--- 3 extreme rapid cycles (no gap) ---');

    for (let i = 0; i < 3; i++) {
      log('B', `Cycle ${i + 1}/3: connect -> immediate disconnect -> reconnect`);

      const ws1 = await connectCDP(PORT);
      await sendCDP(ws1, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
      await sendCDP(ws1, 'Target.setDiscoverTargets', { discover: true });
      ws1.terminate();

      const ws2 = await connectCDP(PORT);
      await sendCDP(ws2, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false });
      await sendCDP(ws2, 'Target.setDiscoverTargets', { discover: true });

      await sleep(2000);

      const pages = await getVisiblePages(ws2);
      assert(pages.length <= baselineCount + 1,
        `B.${i + 1}.1: Cycle ${i + 1} — clean state after rapid reconnect (${pages.length} pages)`,
        `B.${i + 1}.1: Cycle ${i + 1} — dirty state after rapid reconnect (${pages.length} pages)`);

      const nav = await sendCDP(ws2, 'Target.createTarget', { url: 'about:blank' });
      assert(!!nav.result?.targetId,
        `B.${i + 1}.2: Cycle ${i + 1} — page creation works after rapid reconnect`,
        `B.${i + 1}.2: Cycle ${i + 1} — page creation failed: ${JSON.stringify(nav.error)}`);

      ws2.terminate();
    }

    log('B', 'Waiting 8s for cleanup...');
    await sleep(8000);

    const wsVerifyB = await connectCDP(PORT);
    await sendCDP(wsVerifyB, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const pagesFinalB = await getVisiblePages(wsVerifyB);
    assert(pagesFinalB.length <= baselineCount,
      `B.4: No leftover pages after extreme cycles (${pagesFinalB.length} pages)`,
      `B.4: Leftover pages after extreme cycles (${pagesFinalB.length}, expected ≤${baselineCount})`);

    wsVerifyB.close();

  } catch (err) {
    console.error('\nFATAL:', err.message, err.stack);
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
