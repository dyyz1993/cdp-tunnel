#!/usr/bin/env node
'use strict';

/**
 * Test: Large page count stress test
 *
 * 1. Start proxy + Chrome
 * 2. Connect 1 CDP client
 * 3. Create 25 pages sequentially
 * 4. Verify all 25 exist via Target.getTargets
 * 5. Navigate each page to about:blank#N
 * 6. Close all pages individually
 * 7. Verify all gone
 * 8. Print timing info
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19232;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const PAGE_COUNT = 25;

let proxyProcess = null;
let chromeProcess = null;
let originalConfig = null;
let reqId = 0;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sendCDP(ws, method, params = {}) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout [${id}]: ${method}`));
    }, 15000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function patchConfig(port) {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH,
    originalConfig.replace(
      /WS_URL:\s*'ws:\/\/localhost:9221\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (originalConfig) {
    fs.writeFileSync(CONFIG_PATH, originalConfig);
    originalConfig = null;
  }
}

async function waitForProxy(port, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(port, '/json/version');
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function waitForExtension(port, maxWait = 45000) {
  await sleep(5000);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      const result = await Promise.race([
        sendCDP(ws, 'Target.getTargets'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      ws.close();
      reqId = 0;
      if (result && result.targetInfos && result.targetInfos.length > 0) return true;
    } catch (e) {
      log('SETUP', `  Waiting for extension... (${e.message})`);
    }
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
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    if (chromeProcess._profile) {
      try { fs.rmSync(chromeProcess._profile, { recursive: true, force: true }); } catch {}
    }
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Many Pages Stress Test (${PAGE_COUNT} pages) ===\n`);
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (!condition) throw new Error(`Assertion failed: ${msg}`);
  }

  try {
    patchConfig(PROXY_PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('PROXY-ERR', l));
    });

    const userDataDir = `/tmp/many-pages-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;

    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy did not start');
    log('SETUP', 'Proxy ready');

    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    const ws = await connectCDP(PROXY_PORT);
    await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });

    // === Phase 1: Create 25 pages sequentially ===
    log('STRESS', `Creating ${PAGE_COUNT} pages sequentially...`);
    const pageIds = [];
    const createStart = Date.now();

    for (let i = 0; i < PAGE_COUNT; i++) {
      const r = await sendCDP(ws, 'Target.createTarget', { url: `about:blank#${i}` });
      pageIds.push(r.targetId);
      if ((i + 1) % 5 === 0) {
        log('STRESS', `  Created ${i + 1}/${PAGE_COUNT} pages`);
      }
    }

    const createDuration = Date.now() - createStart;
    log('STRESS', `Created ${pageIds.length} pages in ${(createDuration / 1000).toFixed(2)}s`);

    assert(pageIds.length === PAGE_COUNT,
      `Expected ${PAGE_COUNT} page IDs, got ${pageIds.length}`);
    passed++;
    log('TEST', '✅ All 25 pages created successfully');

    // === Phase 2: Verify all pages exist ===
    await sleep(2000);
    const targets = await sendCDP(ws, 'Target.getTargets');
    const foundPages = targets.targetInfos.filter(t =>
      t.type === 'page' && pageIds.includes(t.targetId)
    );

    assert(foundPages.length === PAGE_COUNT,
      `Expected ${PAGE_COUNT} pages in getTargets, found ${foundPages.length}`);
    passed++;
    log('TEST', `✅ Target.getTargets confirms ${foundPages.length} pages`);

    // === Phase 3: Close all pages ===
    log('STRESS', `Closing all ${PAGE_COUNT} pages...`);
    const closeStart = Date.now();
    let closeErrors = 0;

    for (let i = 0; i < pageIds.length; i++) {
      try {
        await sendCDP(ws, 'Target.closeTarget', { targetId: pageIds[i] });
      } catch (e) {
        closeErrors++;
        log('STRESS', `  Error closing page ${i}: ${e.message}`);
      }
      if ((i + 1) % 5 === 0) {
        log('STRESS', `  Closed ${i + 1}/${PAGE_COUNT} pages`);
      }
    }

    const closeDuration = Date.now() - closeStart;
    log('STRESS', `Closed pages in ${(closeDuration / 1000).toFixed(2)}s (${closeErrors} errors)`);

    assert(closeErrors === 0, `${closeErrors} errors during page close`);
    passed++;

    // === Phase 4: Verify all gone ===
    await sleep(5000);
    let survivingPages = [];
    for (let retry = 0; retry < 5; retry++) {
      const targetsAfter = await sendCDP(ws, 'Target.getTargets');
      survivingPages = targetsAfter.targetInfos.filter(t =>
        t.type === 'page' && pageIds.includes(t.targetId)
      );
      if (survivingPages.length === 0) break;
      await sleep(3000);
    }

    assert(survivingPages.length === 0,
      `${survivingPages.length} pages survived bulk close`);
    passed++;

    ws.close();

    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}/4, Failed: ${failed}`);
    console.log(`Timing:`);
    console.log(`  Create ${PAGE_COUNT} pages: ${(createDuration / 1000).toFixed(2)}s`);
    console.log(`  Close  ${PAGE_COUNT} pages: ${(closeDuration / 1000).toFixed(2)}s`);
    console.log('===============\n');

    cleanup();
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Test error:', err);
    failed++;
    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}/4, Failed: ${failed}`);
    console.log('===============\n');
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
