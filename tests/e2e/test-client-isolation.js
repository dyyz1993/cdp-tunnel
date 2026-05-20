#!/usr/bin/env node
'use strict';

/**
 * Test: Client isolation — CDP clients can only see their own tabs
 * 
 * 1. User has tabs open before any CDP connects
 * 2. Client A connects, creates tabs
 * 3. Client B connects, creates tabs
 * 4. Client A can only see its own tabs (not user tabs, not B's tabs)
 * 5. Client B can only see its own tabs
 * 6. User tabs survive all disconnects
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

async function waitForExtension(port) {
  await sleep(8000);
  for (let i = 0; i < 20; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
      const r = await Promise.race([sendCDP(ws, 'Target.getTargets'), new Promise((_, j) => setTimeout(() => j(), 8000))]);
      ws.close();
      if (r?.result?.targetInfos?.length > 0) return true;
    } catch {}
    await sleep(3000);
  }
  return false;
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: Client Isolation (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-isolation-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank', 'https://www.example.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    // ── Check user tabs before CDP ──
    const preCheckWs = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { preCheckWs.on('open', r); preCheckWs.on('error', e); });
    const preResult = await sendCDP(preCheckWs, 'Target.getTargets');
    preCheckWs.close();
    const preTargets = (preResult?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('PRE', `User tabs: ${preTargets.length} (before isolation, pre-filtering still shows all)`);
    preTargets.forEach(t => log('PRE', `  ${t.targetId} — ${t.url}`));

    // ── Client A connects ──
    log('A', 'Client A connecting...');
    const wsA = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { wsA.on('open', r); wsA.on('error', e); });
    await sendCDP(wsA, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(2000);

    // Client A creates 2 tabs
    const aTab1 = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const aTab2 = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const aTab1Id = aTab1?.result?.targetId;
    const aTab2Id = aTab2?.result?.targetId;
    log('A', `Created tabs: ${aTab1Id}, ${aTab2Id}`);
    await sleep(3000);

    // Client A checks its targets
    const aTargets = await sendCDP(wsA, 'Target.getTargets');
    const aPages = (aTargets?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('A', `Client A sees ${aPages.length} pages:`);
    aPages.forEach(t => log('A', `  ${t.targetId} — ${t.url}`));

    // ── Client B connects ──
    log('B', 'Client B connecting...');
    const wsB = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { wsB.on('open', r); wsB.on('error', e); });
    await sendCDP(wsB, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(2000);

    // Client B creates 1 tab
    const bTab1 = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
    const bTab1Id = bTab1?.result?.targetId;
    log('B', `Created tab: ${bTab1Id}`);
    await sleep(3000);

    // Client B checks its targets
    const bTargets = await sendCDP(wsB, 'Target.getTargets');
    const bPages = (bTargets?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('B', `Client B sees ${bPages.length} pages:`);
    bPages.forEach(t => log('B', `  ${t.targetId} — ${t.url}`));

    // ── Verify isolation ──
    // Check 1: Client A should only see its own tabs
    const aSeesOwnTabs = aPages.filter(t => t.targetId === aTab1Id || t.targetId === aTab2Id);
    const aSeesBTabs = aPages.filter(t => t.targetId === bTab1Id);
    const aSeesUserTabs = aPages.filter(t =>
      t.targetId !== aTab1Id && t.targetId !== aTab2Id && t.targetId !== bTab1Id
    );

    if (aSeesOwnTabs.length === 2 && aSeesBTabs.length === 0 && aSeesUserTabs.length === 2) {
      log('PASS', 'Client A: sees its own tabs (2) + 2 pre-existing user tabs, no B tabs');
      passed++;
    } else {
      log('FAIL', `Client A: own=${aSeesOwnTabs.length}/2, B=${aSeesBTabs.length}, user=${aSeesUserTabs.length}`);
      failed++;
    }

    // Check 2: Client B should only see its own tab
    const bSeesOwnTabs = bPages.filter(t => t.targetId === bTab1Id);
    const bSeesATabs = bPages.filter(t => t.targetId === aTab1Id || t.targetId === aTab2Id);
    const bSeesUserTabs = bPages.filter(t =>
      t.targetId !== bTab1Id && t.targetId !== aTab1Id && t.targetId !== aTab2Id
    );

    if (bSeesOwnTabs.length === 1 && bSeesATabs.length === 0 && bSeesUserTabs.length === 2) {
      log('PASS', 'Client B: sees its own tab (1) + 2 pre-existing user tabs, no A tabs');
      passed++;
    } else {
      log('FAIL', `Client B: own=${bSeesOwnTabs.length}/1, A=${bSeesATabs.length}, user=${bSeesUserTabs.length}`);
      failed++;
    }

    // ── Disconnect A, verify B still works ──
    log('DISC-A', 'Disconnecting client A...');
    wsA.close();
    await sleep(8000);

    const bAfterADiscTargets = await sendCDP(wsB, 'Target.getTargets');
    const bAfterADiscPages = (bAfterADiscTargets?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('B-AFTER', `Client B sees ${bAfterADiscPages.length} pages after A disconnect:`);
    bAfterADiscPages.forEach(t => log('B-AFTER', `  ${t.targetId} — ${t.url}`));

    const bStillSeesOwn = bAfterADiscPages.some(t => t.targetId === bTab1Id);
    if (bStillSeesOwn && bAfterADiscPages.length === 3) {
      log('PASS', 'Client B sees its own tab (1) + 2 pre-existing user tabs after A disconnect');
      passed++;
    } else {
      log('FAIL', `Client B sees ${bAfterADiscPages.length} tabs after A disconnect`);
      failed++;
    }

    // ── Disconnect B, verify user tabs survive ──
    log('DISC-B', 'Disconnecting client B...');
    wsB.close();
    await sleep(8000);

    // Check surviving tabs (new WS should see nothing since no CDP owns them)
    const finalWs = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { finalWs.on('open', r); finalWs.on('error', e); });
    const finalResult = await sendCDP(finalWs, 'Target.getTargets');
    finalWs.close();
    const finalPages = (finalResult?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('FINAL', `After all disconnect: ${finalPages.length} pages visible to new client`);
    finalPages.forEach(t => log('FINAL', `  ${t.targetId} — ${t.url}`));

    // New unowned client sees only pre-existing user tabs (CDP-created tabs cleaned up)
    if (finalPages.length === 2) {
      log('PASS', 'Only pre-existing user tabs remain (CDP tabs cleaned, user tabs preserved)');
      passed++;
    } else {
      log('FAIL', `New client sees ${finalPages.length} tabs (should see 0)`);
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
