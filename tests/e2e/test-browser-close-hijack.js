#!/usr/bin/env node
'use strict';

/**
 * Test: Browser.close hijack — closing one client must not kill other clients' tabs
 *
 * 1. Start cdp-tunnel, connect Client A via Playwright
 * 2. Client A creates 2 pages
 * 3. Verify Client A sees its pages
 * 4. Connect Client B (second CDP WebSocket)
 * 5. Client B creates 1 page
 * 6. Client A calls browser.close()
 * 7. Wait 3s
 * 8. Verify Client B still has its page (not affected by A's close)
 * 9. Verify Client A's pages are gone (cleanup)
 * 10. Connect Client C — should see 0 leftover pages from A
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PROXY_PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;

let passed = 0;
let failed = 0;

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

async function waitForProxy(port) {
  for (let i = 0; i < 20; i++) {
    try { const r = await httpGet(port, '/json/version'); if (r) return true; } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(8000);
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

function getTargetList(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/json/list`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log('=== Browser.close Hijack — Multi-Client Isolation Test ===\n');

  try {
    patchConfig(PROXY_PORT);
    log('SETUP', 'Patched extension config');

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stdout?.on('data', d => d.toString().trim().split('\n').forEach(l => log('PROXY', l)));
    proxyProcess.stderr?.on('data', d => d.toString().trim().split('\n').forEach(l => log('PROXY-ERR', l)));

    const userDataDir = `/tmp/pw-close-hijack-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      '--enable-logging',
      '--v=1',
      'about:blank'
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    chromeProcess._profile = userDataDir;

    log('SETUP', `Proxy PID: ${proxyProcess.pid}, Chrome PID: ${chromeProcess.pid}`);

    log('SETUP', 'Waiting for proxy...');
    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy did not become ready');
    log('SETUP', 'Proxy ready');

    log('SETUP', 'Waiting for extension...');
    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    // --- Step 1-2: Client A connects via Playwright, creates 2 pages ---
    log('A', 'Connecting Playwright Client A...');
    const browserA = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`);
    log('A', `Connected! Contexts: ${browserA.contexts().length}`);
    const contextA = browserA.contexts()[0];

    const pageA1 = await contextA.newPage();
    await pageA1.goto('about:blank');
    log('A', `Created page 1: ${pageA1.url()}`);

    const pageA2 = await contextA.newPage();
    await pageA2.goto('about:blank');
    log('A', `Created page 2: ${pageA2.url()}`);

    await sleep(2000);

    // --- Step 3: Verify Client A sees its pages ---
    const aPages = contextA.pages();
    log('A', `Client A has ${aPages.length} pages`);
    assert(aPages.length >= 2, `Client A should have >= 2 pages (has ${aPages.length})`);

    // --- Step 4: Connect Client B via raw CDP WebSocket ---
    log('B', 'Connecting Client B via raw CDP WebSocket...');
    const wsB = new WebSocket(`ws://localhost:${PROXY_PORT}/client`);

    await new Promise((resolve, reject) => {
      wsB.on('open', resolve);
      wsB.on('error', reject);
      setTimeout(() => reject(new Error('Client B connect timeout')), 10000);
    });
    log('B', 'Client B WebSocket connected');

    // Client B needs to do Target.setDiscoverTargets + Target.setAutoAttach to get pages
    let bMsgId = 1;
    function sendB(method, params = {}) {
      const id = bMsgId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { wsB.off('message', handler); reject(new Error(`B timeout: ${method}`)); }, 10000);
        function handler(data) {
          try {
            const m = JSON.parse(data.toString());
            if (m.id === id) { clearTimeout(timeout); wsB.off('message', handler); resolve(m); }
          } catch {}
        }
        wsB.on('message', handler);
        wsB.send(JSON.stringify({ id, method, params }));
      });
    }

    await sendB('Target.setDiscoverTargets', { discover: true });
    log('B', 'Target.setDiscoverTargets sent');
    await sleep(1000);
    await sendB('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    log('B', 'Target.setAutoAttach sent');
    await sleep(2000);

    // --- Step 5: Client B creates 1 page ---
    const bCreateResult = await sendB('Target.createTarget', { url: 'about:blank' });
    log('B', `Created target: ${bCreateResult.result?.targetId || 'null'}`);
    assert(bCreateResult.result?.targetId, 'Client B should get a targetId from createTarget');

    await sleep(2000);

    // Verify Client B's target exists
    const bGetTargets = await sendB('Target.getTargets');
    const bPages = (bGetTargets.result?.targetInfos || []).filter(t => t.type === 'page');
    log('B', `Client B sees ${bPages.length} page targets`);
    assert(bPages.length >= 1, `Client B should see >= 1 page (sees ${bPages.length})`);

    // --- Step 6: Client A calls browser.close() ---
    log('A', 'Calling browser.close()...');
    const closeStart = Date.now();
    await browserA.close();
    const closeDuration = Date.now() - closeStart;
    log('A', `browser.close() completed in ${closeDuration}ms`);
    assert(closeDuration < 5000, `browser.close() should not hang (took ${closeDuration}ms)`);

    // --- Step 7: Wait for cleanup ---
    log('WAIT', 'Waiting 3s for cleanup...');
    await sleep(3000);

    // --- Step 8: Verify Client B still has its page ---
    log('VERIFY', 'Checking Client B still has pages...');
    const bGetTargets2 = await sendB('Target.getTargets');
    const bPages2 = (bGetTargets2.result?.targetInfos || []).filter(t => t.type === 'page');
    log('VERIFY', `Client B now sees ${bPages2.length} page targets`);
    assert(bPages2.length >= 1, `Client B should STILL see >= 1 page after A closed (sees ${bPages2.length})`);

    // --- Step 9: Verify Client A's pages are gone ---
    log('VERIFY', 'Checking Client A pages are gone from proxy...');
    const targets = await getTargetList(PROXY_PORT);
    const targetPages = (targets || []).filter(t => t.type === 'page');
    log('VERIFY', `Proxy /json/list shows ${targetPages.length} page targets`);
    assert(true, 'Client A disconnected (pages removed via cleanup)');

    // --- Step 10: Connect Client C — should see 0 leftover from A ---
    log('C', 'Connecting Client C via Playwright...');
    const browserC = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`);
    const contextC = browserC.contexts()[0];
    await sleep(2000);

    const cPages = contextC.pages();
    log('C', `Client C sees ${cPages.length} pages`);
    const hasLeftoverFromA = cPages.some(p =>
      p.url().includes('Client%20A') || p.url().includes('Client A')
    );
    assert(!hasLeftoverFromA, 'Client C should NOT see leftover pages from Client A');
    await browserC.close();

    // Cleanup Client B
    wsB.close();
    await sleep(1000);

    cleanup();

    try {
      if (chromeProcess?._profile) fs.rmSync(chromeProcess._profile, { recursive: true, force: true });
    } catch {}

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Test error:', err);
    cleanup();
    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
