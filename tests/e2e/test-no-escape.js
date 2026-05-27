#!/usr/bin/env node
'use strict';

/**
 * TDD Test: Tab Escape Prevention — no page left behind after disconnect
 *
 * Bug: When pages are created rapidly right after connection, the group
 * pre-creation in _createGroupForClient is async. If a tab's doGroup
 * runs before the pre-created group Promise resolves, it creates its
 * OWN group via chrome.tabs.group({ tabIds }), leaving the pre-created
 * group empty. The orphaned tab is outside the client's tracked group,
 * so on disconnect it survives cleanup.
 *
 * Fix: doGroup awaits the cached groupCreationPromise before grouping.
 *
 * Round A: Create 5 pages immediately after setDiscoverTargets (no sleep)
 * Round B: Create 10 pages with minimal sleep (race amplification)
 * Round C: Create 5 pages with normal timing (regression baseline)
 *
 * Each round: 4 assertions = 12 total.
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

  profile = `/tmp/cdp-no-escape-test-${Date.now()}`;
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

async function runRound(roundLabel, pageCount, preCreateDelay) {
  let passed = 0, failed = 0;

  log('ROUND', `═══ ${roundLabel}: ${pageCount} pages, pre-delay=${preCreateDelay}ms ═══`);

  const ws = await connectCDP(PORT);
  await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

  if (preCreateDelay > 0) {
    await sleep(preCreateDelay);
  }

  const createPromises = [];
  for (let i = 0; i < pageCount; i++) {
    createPromises.push(sendCDP(ws, 'Target.createTarget', { url: 'about:blank' }));
  }

  log('ROUND', `Firing ${pageCount} concurrent createTarget...`);
  const results = await Promise.all(createPromises);
  const targetIds = results.map(r => r.result?.targetId).filter(Boolean);
  const errors = results.filter(r => r.error);

  log('ROUND', `Created ${targetIds.length}/${pageCount} targets, ${errors.length} errors`);

  await sleep(3000);

  if (targetIds.length === pageCount && errors.length === 0) {
    log('PASS', `${roundLabel}.1: All ${pageCount} createTarget succeeded`);
    passed++;
  } else {
    log('FAIL', `${roundLabel}.1: Got ${targetIds.length}/${pageCount} targets, ${errors.length} errors`);
    failed++;
  }

  const targetsResult = await sendCDP(ws, 'Target.getTargets');
  const pageTargets = (targetsResult.result?.targetInfos || []).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
  );
  const ownedPages = pageTargets.filter(t => targetIds.includes(t.targetId));

  log('ROUND', `getTargets: ${pageTargets.length} total, ${ownedPages.length} owned`);

  if (ownedPages.length === pageCount) {
    log('PASS', `${roundLabel}.2: All ${pageCount} pages visible via getTargets`);
    passed++;
  } else {
    log('FAIL', `${roundLabel}.2: Only ${ownedPages.length}/${pageCount} pages visible`);
    failed++;
  }

  const listAfter = await httpGet(PORT, '/json/list');
  const browserTabs = (listAfter || []).filter(t => t.type === 'page');
  const maxExpected = pageCount + 3;
  log('ROUND', `Browser /json/list: ${browserTabs.length} page tabs`);

  if (browserTabs.length >= pageCount && browserTabs.length <= maxExpected) {
    log('PASS', `${roundLabel}.3: Browser tab count ${browserTabs.length} in range (${pageCount}-${maxExpected})`);
    passed++;
  } else {
    log('FAIL', `${roundLabel}.3: Browser tab count ${browserTabs.length} outside range (${pageCount}-${maxExpected})`);
    failed++;
  }

  ws.terminate();
  log('ROUND', 'Disconnected, waiting 10s for cleanup...');
  await sleep(10000);

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
    log('PASS', `${roundLabel}.4: No leftover pages — all tabs cleaned up`);
    passed++;
  } else {
    log('FAIL', `${roundLabel}.4: ${leftoverPages.length} leftover pages escaped cleanup!`);
    failed++;
    leftoverPages.forEach(t => log('FAIL', `  leftover: ${t.targetId?.substring(0, 12)} ${t.url?.substring(0, 40)}`));
  }

  ws2.close();
  await sleep(3000);

  return { passed, failed };
}

async function runTest() {
  console.log(`\n=== Test: No Tab Escape (3 rounds, port ${PORT}) ===\n`);
  let totalPassed = 0, totalFailed = 0;

  try {
    await setup();

    let r;

    r = await runRound('A-Immediate', 5, 0);
    totalPassed += r.passed; totalFailed += r.failed;

    r = await runRound('B-Burst10', 10, 100);
    totalPassed += r.passed; totalFailed += r.failed;

    r = await runRound('C-Normal', 5, 1000);
    totalPassed += r.passed; totalFailed += r.failed;

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
