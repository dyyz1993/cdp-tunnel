#!/usr/bin/env node
'use strict';

/**
 * TDD Test: Concurrent Target.createTarget race condition
 *
 * Bug: When calling Target.createTarget 3 times concurrently,
 * addTabToAutomationGroup was called 3 times in parallel. Each call
 * queried chrome.tabGroups.query, found no group, and created its own
 * group — resulting in 3 separate groups instead of 1.
 *
 * Fix: Per-clientId promise queue serializes group operations so the
 * first call creates the group and subsequent calls find it.
 *
 * Verifications:
 * 1. Concurrent Target.createTarget × 3 → all succeed
 * 2. Target.getTargets shows all 3 new pages owned by this client
 * 3. After disconnect + reconnect, no leftover pages from previous client
 * 4. Page count is correct (no duplicates, no lost pages)
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

  profile = `/tmp/cdp-concurrent-test-${Date.now()}`;
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
  console.log(`\n=== Test: Concurrent Target.createTarget Race (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    await setup();

    // ═══════════════════════════════════════════
    // Test A: Concurrent createTarget — all succeed
    // ═══════════════════════════════════════════
    log('A', '--- Test A: 3 concurrent Target.createTarget all succeed ---');

    const ws1 = await connectCDP(PORT);
    await sendCDP(ws1, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    log('A', 'Firing 3 concurrent Target.createTarget...');
    const concurrentPromises = [
      sendCDP(ws1, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(ws1, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(ws1, 'Target.createTarget', { url: 'about:blank' }),
    ];
    const results = await Promise.all(concurrentPromises);
    const targetIds = results.map(r => r.result?.targetId).filter(Boolean);
    const errors = results.filter(r => r.error);

    log('A', `Created ${targetIds.length} targets, ${errors.length} errors`);
    targetIds.forEach((t, i) => log('A', `  target[${i}]: ${t?.substring(0, 12)}`));

    if (targetIds.length === 3 && errors.length === 0) {
      log('PASS', 'A.1: All 3 concurrent createTarget succeeded');
      passed++;
    } else {
      log('FAIL', `A.1: Got ${targetIds.length}/3 targets, ${errors.length} errors`);
      failed++;
    }

    await sleep(3000);

    // ═══════════════════════════════════════════
    // Test B: All 3 pages visible via getTargets
    // ═══════════════════════════════════════════
    log('B', '--- Test B: Target.getTargets shows all 3 pages ---');

    const targetsResult = await sendCDP(ws1, 'Target.getTargets');
    const pageTargets = (targetsResult.result?.targetInfos || []).filter(
      t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
    );
    const ownedPages = pageTargets.filter(t => targetIds.includes(t.targetId));

    log('B', `getTargets: ${pageTargets.length} total pages, ${ownedPages.length} owned by this client`);
    pageTargets.forEach(t => log('B', `  ${t.targetId?.substring(0, 12)} ${t.url?.substring(0, 40)}`));

    if (ownedPages.length === 3) {
      log('PASS', 'B.1: All 3 created pages visible via getTargets');
      passed++;
    } else {
      log('FAIL', `B.1: Only ${ownedPages.length}/3 created pages visible`);
      failed++;
    }

    // ═══════════════════════════════════════════
    // Test C: Browser tab count is correct
    // ═══════════════════════════════════════════
    log('C', '--- Test C: Browser tab count correct ---');

    const listAfter = await httpGet(PORT, '/json/list');
    const browserTabs = (listAfter || []).filter(t => t.type === 'page');
    log('C', `Browser /json/list: ${browserTabs.length} page tabs`);

    // Should have at least 3 created + default page, but not 6+ (which would indicate duplicate groups)
    if (browserTabs.length >= 3 && browserTabs.length <= 5) {
      log('PASS', `C.1: Browser tab count ${browserTabs.length} in expected range (3-5)`);
      passed++;
    } else {
      log('FAIL', `C.1: Browser tab count ${browserTabs.length} outside expected range (3-5)`);
      failed++;
    }

    // ═══════════════════════════════════════════
    // Test D: Clean disconnect — no leftover pages
    // ═══════════════════════════════════════════
    log('D', '--- Test D: Clean disconnect — no leftover pages ---');

    const listBaseline = await httpGet(PORT, '/json/list');
    const baselineTabs = (listBaseline || []).filter(t => t.type === 'page').length;
    log('D', `Baseline tabs before disconnect: ${baselineTabs}`);

    ws1.terminate();

    log('D', 'Waiting 8 seconds for cleanup...');
    await sleep(8000);

    const listAfterCleanup = await httpGet(PORT, '/json/list');
    const afterCleanupTabs = (listAfterCleanup || []).filter(t => t.type === 'page').length;
    log('D', `Tabs after cleanup: ${afterCleanupTabs} (baseline was ${baselineTabs})`);

    // After disconnect, all CDP-created tabs should be cleaned up
    // The baseline before this client connected was likely 0-1 pages
    const listPostCleanup = await httpGet(PORT, '/json/list');
    const postCleanupPages = (listPostCleanup || []).filter(t => t.type === 'page');
    log('D', `Post-cleanup browser pages: ${postCleanupPages.length}`);

    // Connect a new client to verify no leftover pages
    const ws2 = await connectCDP(PORT);
    await sendCDP(ws2, 'Target.setDiscoverTargets', { discover: true });
    await sleep(2000);

    const targets2 = await sendCDP(ws2, 'Target.getTargets');
    const pages2 = (targets2.result?.targetInfos || []).filter(
      t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
    );

    const leftoverPages = pages2.filter(t => targetIds.includes(t.targetId));
    log('D', `New client sees ${pages2.length} pages, ${leftoverPages.length} leftover from previous client`);

    if (leftoverPages.length === 0) {
      log('PASS', 'D.1: No leftover pages from previous client after disconnect');
      passed++;
    } else {
      log('FAIL', `D.1: ${leftoverPages.length} leftover pages from previous client`);
      failed++;
    }

    ws2.close();
    await sleep(2000);

    // ═══════════════════════════════════════════
    // Test E: Rapid 5-page concurrent creation
    // ═══════════════════════════════════════════
    log('E', '--- Test E: Rapid 5-page concurrent creation ---');

    const ws3 = await connectCDP(PORT);
    await sendCDP(ws3, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    log('E', 'Firing 5 concurrent Target.createTarget...');
    const rapid5 = await Promise.all([
      sendCDP(ws3, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(ws3, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(ws3, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(ws3, 'Target.createTarget', { url: 'about:blank' }),
      sendCDP(ws3, 'Target.createTarget', { url: 'about:blank' }),
    ]);
    const rapid5Ids = rapid5.map(r => r.result?.targetId).filter(Boolean);
    const rapid5Errors = rapid5.filter(r => r.error);

    log('E', `Created ${rapid5Ids.length} targets, ${rapid5Errors.length} errors`);

    if (rapid5Ids.length === 5 && rapid5Errors.length === 0) {
      log('PASS', 'E.1: All 5 concurrent createTarget succeeded');
      passed++;
    } else {
      log('FAIL', `E.1: Got ${rapid5Ids.length}/5 targets, ${rapid5Errors.length} errors`);
      failed++;
    }

    await sleep(3000);

    const targetsE = await sendCDP(ws3, 'Target.getTargets');
    const ePages = (targetsE.result?.targetInfos || []).filter(
      t => t.type === 'page' && !t.url.startsWith('chrome-extension://')
    );
    const eOwned = ePages.filter(t => rapid5Ids.includes(t.targetId));

    log('E', `getTargets: ${ePages.length} total, ${eOwned.length} owned`);

    if (eOwned.length === 5) {
      log('PASS', 'E.2: All 5 rapid pages visible and owned');
      passed++;
    } else {
      log('FAIL', `E.2: Only ${eOwned.length}/5 rapid pages visible`);
      failed++;
    }

    ws3.close();
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
