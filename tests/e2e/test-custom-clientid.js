#!/usr/bin/env node
'use strict';

/**
 * Test: Custom clientId via /client-<id> WebSocket path
 *
 * Verifies:
 * 1. Custom clientId connects and creates pages
 * 2. Different custom clientIds get different groups (isolation)
 * 3. Same custom clientId reconnecting gets a fresh start
 * 4. Short custom clientIds that are prefixes of each other don't collide
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 19000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;
let _requestId = 0;

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendCDP(ws, method, params = {}) {
  const id = ++_requestId;
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
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

function connectCustom(port, clientId) {
  const wsPath = clientId ? `/client-${clientId}` : '/client';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${wsPath}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function initClient(ws) {
  await sendCDP(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
  await sleep(1500);
}

async function createPages(ws, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const res = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
    const tid = res?.result?.targetId;
    if (tid) ids.push(tid);
  }
  await sleep(2000);
  return ids;
}

async function getPages(ws) {
  const res = await sendCDP(ws, 'Target.getTargets');
  return (res?.result?.targetInfos || []).filter(t => t.type === 'page');
}

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

async function waitForProxy(port) {
  for (let i = 0; i < 30; i++) {
    try { const r = await httpGet(port, '/json/version'); if (r) return true; } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  await sleep(8000);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const list = await httpGet(port, '/json/list');
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) { await sleep(1000); return true; }
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

async function setup() {
  patchConfig(PORT);
  proxyProcess = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (!await waitForProxy(PORT)) throw new Error('Proxy failed to start');

  const profile = `/tmp/cdp-custom-id-test-${Date.now()}`;
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
  chromeProcess._profile = profile;

  if (!await waitForExtension(PORT)) throw new Error('Extension failed to load');
  log('SETUP', `Ready on port ${PORT}`);
}

async function runTest() {
  console.log(`\n=== Test: Custom ClientID (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  async function check(label, condition) {
    if (condition) { log('PASS', label); passed++; }
    else { log('FAIL', label); failed++; }
  }

  try {
    await setup();

    // ═══════════════════════════════════════════
    // Test 1: Custom clientId connects and creates pages
    // ═══════════════════════════════════════════
    log('T1', 'Custom clientId connects and creates pages');
    {
      const ws = await connectCustom(PORT, 'myCustomClient1');
      await initClient(ws);
      const createdIds = await createPages(ws, 2);
      const pages = await getPages(ws);
      const ownsAll = createdIds.every(id => pages.some(p => p.targetId === id));

      await check('T1: Created 2 pages', createdIds.length === 2);
      await check('T1: getTargets returns 2+ pages', pages.length >= 2);
      await check('T1: All created pages visible', ownsAll);

      ws.close();
      await sleep(5000);
    }

    // ═══════════════════════════════════════════
    // Test 2: Different custom clientIds get different groups
    // ═══════════════════════════════════════════
    log('T2', 'Different custom clientIds get different groups');
    {
      const wsA = await connectCustom(PORT, 'testAlpha');
      await initClient(wsA);
      const idsA = await createPages(wsA, 2);

      const wsB = await connectCustom(PORT, 'testBeta');
      await initClient(wsB);
      const idsB = await createPages(wsB, 2);

      const pagesA = await getPages(wsA);
      const pagesB = await getPages(wsB);

      const aSeesOwn = idsA.filter(id => pagesA.some(p => p.targetId === id)).length;
      const aSeesB = idsB.filter(id => pagesA.some(p => p.targetId === id)).length;
      const bSeesOwn = idsB.filter(id => pagesB.some(p => p.targetId === id)).length;
      const bSeesA = idsA.filter(id => pagesB.some(p => p.targetId === id)).length;

      await check('T2: Client A sees own 2 pages', aSeesOwn === 2);
      await check('T2: Client A sees 0 of B pages', aSeesB === 0);
      await check('T2: Client B sees own 2 pages', bSeesOwn === 2);
      await check('T2: Client B sees 0 of A pages', bSeesA === 0);

      wsA.close();
      wsB.close();
      await sleep(5000);
    }

    // ═══════════════════════════════════════════
    // Test 3: Same custom clientId reconnecting
    // ═══════════════════════════════════════════
    log('T3', 'Same custom clientId reconnecting');
    {
      const wsA = await connectCustom(PORT, 'sameId');
      await initClient(wsA);
      const idsA = await createPages(wsA, 1);
      const pagesA = await getPages(wsA);
      await check('T3-A: Client A created 1 page', idsA.length === 1);
      await check('T3-A: Client A sees its page', pagesA.some(p => p.targetId === idsA[0]));

      wsA.close();
      log('T3', 'Client A disconnected, waiting 5s for cleanup...');
      await sleep(5000);

      const wsB = await connectCustom(PORT, 'sameId');
      await initClient(wsB);
      const pagesB = await getPages(wsB);

      const leftoverFromA = pagesB.filter(p => idsA.includes(p.targetId)).length;
      await check('T3-B: Client B sees 0 leftover pages from A', leftoverFromA === 0);

      const idsB = await createPages(wsB, 1);
      const pagesB2 = await getPages(wsB);
      await check('T3-B: Client B creates 1 page', idsB.length === 1);
      await check('T3-B: Client B sees its new page', pagesB2.some(p => p.targetId === idsB[0]));

      wsB.close();
      await sleep(5000);
    }

    // ═══════════════════════════════════════════
    // Test 4: Short custom clientIds don't collide (prefix safety)
    // ═══════════════════════════════════════════
    log('T4', 'Short custom clientIds prefix safety');
    {
      const wsShort = await connectCustom(PORT, 'abc');
      await initClient(wsShort);
      const idsShort = await createPages(wsShort, 2);

      const wsPrefix = await connectCustom(PORT, 'abcd');
      await initClient(wsPrefix);
      const idsPrefix = await createPages(wsPrefix, 2);

      const pagesShort = await getPages(wsShort);
      const pagesPrefix = await getPages(wsPrefix);

      const shortSeesOwn = idsShort.filter(id => pagesShort.some(p => p.targetId === id)).length;
      const shortSeesOther = idsPrefix.filter(id => pagesShort.some(p => p.targetId === id)).length;
      const prefixSeesOwn = idsPrefix.filter(id => pagesPrefix.some(p => p.targetId === id)).length;
      const prefixSeesOther = idsShort.filter(id => pagesPrefix.some(p => p.targetId === id)).length;

      await check('T4: /client-abc sees own 2 pages', shortSeesOwn === 2);
      await check('T4: /client-abc sees 0 of /client-abcd pages', shortSeesOther === 0);
      await check('T4: /client-abcd sees own 2 pages', prefixSeesOwn === 2);
      await check('T4: /client-abcd sees 0 of /client-abc pages', prefixSeesOther === 0);

      wsShort.close();
      wsPrefix.close();
      await sleep(3000);
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
