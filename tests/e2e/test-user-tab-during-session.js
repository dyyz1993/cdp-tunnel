#!/usr/bin/env node
'use strict';

/**
 * Test: User opens tab DURING CDP session → Playwright discovers & attaches → tab must survive disconnect
 *
 * Simulates the real scenario:
 * 1. Playwright connected, CDP group exists
 * 2. User opens Baidu tab (Ctrl+T) — NOT via CDP
 * 3. Playwright discovers it via Target.getTargets, sends Target.attachToTarget
 * 4. Extension's targetAttachToTarget should treat it as pre-existing (not CDP-created)
 * 5. On disconnect: user tab survives, CDP tabs cleaned up
 *
 * Fix: targetAttachToTarget checks isCDPCreatedTab() — non-CDP tabs
 * get preExistingTab protection (no group add, survive disconnect).
 */

const { chromium } = require('playwright');
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

async function getPages(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  const r = await sendCDP(ws, 'Target.getTargets');
  ws.close();
  return (r?.result?.targetInfos || []).filter(t => t.type === 'page');
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: User Tab During Session (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-session-tab-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank', 'https://www.example.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    const prePages = await getPages(PORT);
    const preTargetIds = prePages.map(t => t.targetId);
    log('PRE', `${prePages.length} user tabs before CDP`);

    // ── Step 1: Connect Playwright, create CDP tab ──
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    await sleep(3000);

    const cdpPage = await ctx.newPage(); await cdpPage.goto('about:blank');
    log('PW', 'CDP tab created');
    await sleep(5000);

    const pagesAfterGroup = await getPages(PORT);
    const cdpTargetIds = pagesAfterGroup
      .filter(t => !preTargetIds.includes(t.targetId))
      .map(t => t.targetId);
    log('PW', `CDP targets: ${cdpTargetIds.join(', ')}`);

    // ── Step 2: Simulate user Ctrl+T via second WS using Target.createTarget ──
    // Key: this creates a tab that IS tracked as CDP-created on THIS WS client.
    // But then we simulate what happens when a THIRD party (like another Playwright)
    // discovers and attaches to it via Target.attachToTarget.
    //
    // More realistic: create tab via SECOND Playwright connection (different client),
    // then check if first Playwright attaching to it would protect it.
    //
    // Actually, the simplest way to test the fix:
    // 1. Create a tab via Target.createTarget on WS-A (marks as CDP-created for WS-A's client)
    // 2. Close WS-A (disconnect that client)
    // 3. Tab should be deleted (it's CDP-created for that client)
    //
    // AND:
    // 1. A pre-existing tab (not CDP-created)
    // 2. Playwright attaches via Target.attachToTarget
    // 3. Tab should survive disconnect

    // ── Scenario A: Tab created via Target.createTarget on separate WS → deleted on that WS close ──
    log('A', 'Creating tab via separate WS (Target.createTarget)...');
    const wsA = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { wsA.on('open', r); wsA.on('error', e); });
    const tabAResult = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const tabAId = tabAResult?.result?.targetId;
    log('A', `Tab A created: ${tabAId}`);
    await sleep(3000);

    // Close WS-A → tab A should be deleted (it was CDP-created for WS-A's client)
    wsA.close();
    log('A', 'WS-A closed, waiting for cleanup...');
    await sleep(8000);

    const afterACleanup = await getPages(PORT);
    const aSurvivedAfterWSClose = afterACleanup.some(t => t.targetId === tabAId);
    log('A', `Tab A after WS-A close: ${aSurvivedAfterWSClose ? 'SURVIVED' : 'DELETED'}`);

    // ── Scenario B: Existing user tab, Playwright does Target.attachToTarget → should survive ──
    // Use the pre-existing about:blank tab
    const preBlankTarget = prePages.find(t => t.url === 'about:blank');
    if (preBlankTarget) {
      log('B', `Pre-existing tab ${preBlankTarget.targetId}, attaching via Target.attachToTarget...`);
      const wsB = new WebSocket(`ws://localhost:${PORT}/client`);
      await new Promise((r, e) => { wsB.on('open', r); wsB.on('error', e); });
      const attachResult = await sendCDP(wsB, 'Target.attachToTarget', {
        targetId: preBlankTarget.targetId
      });
      log('B', `attachToTarget: ${JSON.stringify(attachResult?.result?.sessionId ? 'OK' : attachResult?.error)}`);
      await sleep(2000);
      wsB.close();
      await sleep(2000);
    }

    // Snapshot before disconnect
    const beforePages = await getPages(PORT);
    log('BEFORE', `${beforePages.length} pages before main disconnect`);
    beforePages.forEach(t => {
      const isPre = preTargetIds.includes(t.targetId);
      const isCDP = cdpTargetIds.includes(t.targetId);
      log('BEFORE', `  ${isPre ? 'PRE' : isCDP ? 'CDP' : 'OTHER'} ${t.targetId} — ${t.url}`);
    });

    // ── Disconnect main Playwright ──
    log('DISC', 'Disconnecting main Playwright...');
    await browser.close();
    await sleep(10000);

    const finalPages = await getPages(PORT);
    log('FINAL', `${finalPages.length} surviving pages`);
    finalPages.forEach(t => {
      const isPre = preTargetIds.includes(t.targetId);
      log('FINAL', `  ${isPre ? 'PRE' : 'LEAK'} ${t.targetId} — ${t.url}`);
    });

    // Check 1: Pre-existing user tabs survive (including one that was Target.attachToTarget'd)
    const preSurvived = finalPages.filter(t => preTargetIds.includes(t.targetId));
    if (preSurvived.length >= preTargetIds.length) {
      log('PASS', 'Pre-existing user tabs survive (including attachToTarget\'d tab)');
      passed++;
    } else {
      log('FAIL', `${preSurvived.length}/${preTargetIds.length} pre-existing tabs survive`);
      failed++;
    }

    // Check 2: CDP-created tabs cleaned up
    const cdpLeaks = finalPages.filter(t => cdpTargetIds.includes(t.targetId));
    if (cdpLeaks.length === 0) {
      log('PASS', 'CDP tabs properly cleaned up');
      passed++;
    } else {
      log('FAIL', `${cdpLeaks.length} CDP tabs leaked`);
      cdpLeaks.forEach(t => log('FAIL', `  ${t.targetId} — ${t.url}`));
      failed++;
    }

    // Check 3: Tab A (created on separate WS) was cleaned up when WS closed
    if (!aSurvivedAfterWSClose) {
      log('PASS', 'Tab A (CDP-created on separate WS) was cleaned up on WS close');
      passed++;
    } else {
      log('FAIL', 'Tab A survived WS close — should have been cleaned up');
      failed++;
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
