#!/usr/bin/env node
'use strict';

/**
 * Test: Client isolation for existing pages
 *
 * 1. Create 3 pages via Client A (raw CDP)
 * 2. Connect Playwright as Client B — verify it does NOT see Client A's pages
 * 3. Playwright creates its own page — verify it works
 * 4. Disconnect Playwright — verify Client A's pages survive
 * 5. Disconnect Client A — verify only extension/blank pages remain
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const STATE_FILE = path.join(os.homedir(), '.cdp-tunnel', 'extension-state.json');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;
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

async function waitForProxy(port) {
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', reject);
      });
      return true;
    } catch {}
    await sleep(500);
  }
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
    } catch (e) { log('SETUP', `  Waiting for extension... (${e.message})`); }
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
  console.log(`=== Test: Client isolation for existing pages (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/existing-pages-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--load-extension=${EXTENSION_PATH}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Extension connected');

    // ── Phase 1: Client A creates 3 pages ──
    log('C1', 'Connecting Client A...');
    const wsA = await connectCDP(PORT);
    log('C1', 'Creating 3 pages...');
    const pagesA = [];
    for (let i = 0; i < 3; i++) {
      const r = await sendCDP(wsA, 'Target.createTarget', { url: 'https://www.example.com/?existing=' + i });
      pagesA.push(r.result.targetId);
    }
    log('C1', `Created ${pagesA.length} pages`);
    await sleep(2000);

    // Client A verifies it sees its 3 pages
    const targetsA = await sendCDP(wsA, 'Target.getTargets');
    const seenA = (targetsA.result?.targetInfos || []).filter(t => t.type === 'page' && t.url.includes('example.com'));
    if (seenA.length === 3) {
      log('PASS', 'Client A sees its 3 pages');
      passed++;
    } else {
      log('FAIL', `Client A sees ${seenA.length} pages (expected 3)`);
      failed++;
    }

    // ── Phase 2: Connect Playwright as Client B — verify isolation ──
    log('C2', 'Connecting Playwright as Client B...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 15000 });
    const ctx = browser.contexts()[0];

    // Playwright must NOT see Client A's pages
    const pagesB = ctx.pages();
    log('C2', `Playwright sees ${pagesB.length} existing pages`);
    const clientAPagesVisible = pagesB.filter(p => p.url().includes('example.com'));
    if (clientAPagesVisible.length === 0) {
      log('PASS', 'Client B correctly cannot see Client A\'s pages (isolation)');
      passed++;
    } else {
      log('FAIL', `Client B sees ${clientAPagesVisible.length} of Client A\'s pages`);
      failed++;
    }

    // ── Phase 3: Playwright creates its own page ──
    log('C2', 'Creating own page via Playwright...');
    const page1 = await ctx.newPage();
    await page1.goto('about:blank');
    log('C2', `Playwright page created: ${page1.url()}`);
    await sleep(2000);

    // Playwright now sees its own page (total can be >1 due to pre-existing pages)
    const pagesB2 = ctx.pages();
    const hasOwnPage = pagesB2.some(p => p === page1);
    const seesClientAPages2 = pagesB2.filter(p => p.url().includes('example.com'));
    if (hasOwnPage && seesClientAPages2.length === 0) {
      log('PASS', 'Playwright sees its own page, not Client A\'s');
      passed++;
    } else {
      log('FAIL', `Playwright hasOwn=${hasOwnPage}, sees ${seesClientAPages2.length} of A's pages, total=${pagesB2.length}`);
      failed++;
    }

    // Client A still sees ONLY its 3 pages, not Playwright's
    const targetsA2 = await sendCDP(wsA, 'Target.getTargets');
    const seenA2 = (targetsA2.result?.targetInfos || []).filter(t => t.type === 'page' && t.url.includes('example.com'));
    if (seenA2.length === 3) {
      log('PASS', 'Client A still sees its 3 pages (Playwright\'s page not leaking)');
      passed++;
    } else {
      log('FAIL', `Client A sees ${seenA2.length} pages (expected 3)`);
      failed++;
    }

    // ── Phase 4: Close Playwright ──
    log('DISC', 'Disconnecting Playwright...');
    await browser.close();
    await sleep(5000);

    // Client A's pages must survive
    const targetsA3 = await sendCDP(wsA, 'Target.getTargets');
    const seenA3 = (targetsA3.result?.targetInfos || []).filter(t => t.type === 'page' && t.url.includes('example.com'));
    if (seenA3.length === 3) {
      log('PASS', 'Client A\'s pages survive Playwright disconnect');
      passed++;
    } else {
      log('FAIL', `Client A has ${seenA3.length} pages after Playwright disconnect (expected 3)`);
      failed++;
    }

    wsA.close();
    await sleep(3000);

  } catch (err) {
    console.error('\nFATAL:', (err && err.message) || String(err) || 'unknown error');
    console.error('Stack:', (err && err.stack) || 'no stack');
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
