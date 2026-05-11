#!/usr/bin/env node
'use strict';

/**
 * Test: Tab created via CDP during session — survives disconnect or not?
 *
 * Scenario: User opens tab AFTER group exists.
 * Two sub-scenarios:
 * A) Tab created via Playwright (CDP path) → should be cleaned on disconnect
 * B) Tab created via separate WS then WS closed → "user took over" → should survive?
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
  console.log(`=== Test: Tab Created During Session (port ${PORT}) ===\n`);
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

    // Connect Playwright
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    await sleep(3000);

    // Create CDP tab → group exists
    const cdpPage = await ctx.newPage(); await cdpPage.goto('about:blank');
    log('PW', '1 CDP tab created, group should exist');
    await sleep(5000);

    // ── Scenario A: Tab created via separate WS, then WS closes ──
    // This simulates "user opens a tab that goes through CDP, then disconnects"
    log('A', 'Creating tab via separate WS...');
    const wsA = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { wsA.on('open', r); wsA.on('error', e); });
    const tabAResult = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
    const tabAId = tabAResult?.result?.targetId;
    wsA.close();
    log('A', `Tab A created via separate WS: ${tabAId}`);
    await sleep(5000);

    // ── Scenario B: Tab created via Playwright (normal CDP) ──
    const cdpPage2 = await ctx.newPage(); await cdpPage2.goto('about:blank');
    log('B', 'Tab B created via Playwright');
    await sleep(3000);

    // Snapshot before disconnect
    const beforePages = await getPages(PORT);
    log('BEFORE', `${beforePages.length} pages`);
    beforePages.forEach(t => {
      const isPre = preTargetIds.includes(t.targetId);
      const isA = t.targetId === tabAId;
      log('BEFORE', `  ${isPre ? 'PRE' : isA ? 'TAB_A' : 'CDP'} ${t.targetId} — ${t.url}`);
    });

    // Disconnect
    log('DISC', 'Disconnecting...');
    await browser.close();
    await sleep(10000);

    const finalPages = await getPages(PORT);
    log('FINAL', `${finalPages.length} surviving pages`);
    finalPages.forEach(t => {
      const isPre = preTargetIds.includes(t.targetId);
      const isA = t.targetId === tabAId;
      log('FINAL', `  ${isPre ? 'PRE' : isA ? 'TAB_A' : 'LEAK'} ${t.targetId} — ${t.url}`);
    });

    // Check 1: Pre-existing user tabs survive
    const preSurvived = finalPages.filter(t => preTargetIds.includes(t.targetId));
    if (preSurvived.length >= preTargetIds.length) {
      log('PASS', 'Pre-existing user tabs survive');
      passed++;
    } else {
      log('FAIL', `${preSurvived.length}/${preTargetIds.length} pre-existing tabs survive`);
      failed++;
    }

    // Check 2: Tab A (separate WS, closed WS) — was it deleted?
    if (tabAId) {
      const aSurvived = finalPages.some(t => t.targetId === tabAId);
      log('RESULT', `Tab A (separate WS create, WS closed): ${aSurvived ? 'SURVIVED' : 'DELETED'}`);
      if (aSurvived) {
        log('PASS', 'Tab A survived (user opened tab not killed by disconnect)');
        passed++;
      } else {
        log('FAIL', 'Tab A was DELETED — user tab opened during session got killed!');
        failed++;
      }
    }

    // Check 3: No CDP leaks
    const leaks = finalPages.filter(t =>
      !preTargetIds.includes(t.targetId) &&
      t.targetId !== tabAId &&
      !t.url.startsWith('chrome-extension://')
    );
    if (leaks.length === 0) {
      log('PASS', 'No CDP tab leaks');
      passed++;
    } else {
      log('FAIL', `${leaks.length} CDP tabs leaked`);
      leaks.forEach(t => log('FAIL', `  ${t.targetId} — ${t.url}`));
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
