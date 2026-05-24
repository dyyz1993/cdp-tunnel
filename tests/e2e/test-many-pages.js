#!/usr/bin/env node
'use strict';

/**
 * Test: Large page count stress test
 *
 * 1. Start proxy + Chrome
 * 2. Connect 1 CDP client
 * 3. Create 25 pages sequentially via Target.createTarget
 * 4. Verify Target.getTargets returns 25+ pages
 * 5. Print timing (how long to create 25 pages)
 * 6. Close all pages sequentially via Target.closeTarget
 * 7. Verify all gone
 * 8. Print timing (how long to close)
 * 9. Print PASS/FAIL summary
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

const PAGE_COUNT = 25;

let proxyProcess = null;
let chromeProcess = null;
let originalConfig = null;
let _requestId = 0;

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

function patchConfig(port) {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH,
    originalConfig.replace(
      /WS_URL:\s*'ws:\/\/localhost:\d+\/plugin'/,
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

function sendCDP(ws, method, params = {}) {
  const id = ++_requestId;
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

async function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
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

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(5000);
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
  console.log('=== Many Pages Stress E2E Test ===\n');
  const results = [];

  try {
    patchConfig(PROXY_PORT);
    log('SETUP', 'Patched extension config');

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('PROXY-ERR', l));
    });
    log('SETUP', `Proxy started (PID: ${proxyProcess.pid})`);

    const userDataDir = `/tmp/many-pages-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;
    log('SETUP', `Chrome started (PID: ${chromeProcess.pid})`);

    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy did not become ready');
    log('SETUP', 'Proxy is ready');

    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    // Step 2: Connect 1 CDP client
    const ws = await connectCDP(PROXY_PORT);
    await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
    log('TEST', 'CDP client connected');

    // Step 3: Create 25 pages sequentially
    log('TEST', `Creating ${PAGE_COUNT} pages sequentially...`);
    const pageIds = [];
    const createStart = Date.now();

    for (let i = 0; i < PAGE_COUNT; i++) {
      const r = await sendCDP(ws, 'Target.createTarget', { url: `https://www.example.com/?page${i}` });
      pageIds.push(r.targetId);
      if ((i + 1) % 5 === 0) {
        log('TEST', `  Created ${i + 1}/${PAGE_COUNT} pages`);
      }
    }

    const createDuration = Date.now() - createStart;
    log('TEST', `Created ${PAGE_COUNT} pages in ${createDuration}ms (${(createDuration / PAGE_COUNT).toFixed(0)}ms/page avg)`);
    results.push({ name: `Create ${PAGE_COUNT} pages`, pass: pageIds.length === PAGE_COUNT });

    await sleep(3000);

    // Step 4: Verify page count
    log('TEST', 'Verifying page count...');
    const targets = await sendCDP(ws, 'Target.getTargets');
    const myPages = targets.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?page'));
    const t4 = myPages.length >= PAGE_COUNT;
    results.push({ name: `Target.getTargets returns ${PAGE_COUNT}+ pages (${myPages.length} found)`, pass: t4 });
    log('TEST', `Found ${myPages.length} pages (expected ${PAGE_COUNT}+) — ${t4 ? 'OK' : 'FAIL'}`);

    // Step 5: Print timing (already printed above)
    results.push({ name: `Create timing: ${createDuration}ms total`, pass: true });

    // Step 6: Close all pages sequentially
    log('TEST', `Closing all ${pageIds.length} pages sequentially...`);
    const closeStart = Date.now();
    let closedCount = 0;

    for (const targetId of pageIds) {
      try {
        await sendCDP(ws, 'Target.closeTarget', { targetId });
        closedCount++;
        if (closedCount % 5 === 0) {
          log('TEST', `  Closed ${closedCount}/${pageIds.length} pages`);
        }
      } catch (e) {
        log('TEST', `  Failed to close ${targetId}: ${e.message}`);
      }
    }

    const closeDuration = Date.now() - closeStart;
    log('TEST', `Closed ${closedCount} pages in ${closeDuration}ms (${(closeDuration / closedCount).toFixed(0)}ms/page avg)`);
    results.push({ name: `Close all pages (${closedCount}/${pageIds.length})`, pass: closedCount === pageIds.length });

    await sleep(3000);

    // Step 7: Verify all gone
    log('TEST', 'Verifying all pages are gone...');
    const targetsAfter = await sendCDP(ws, 'Target.getTargets');
    const remainingPages = targetsAfter.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?page'));
    const t7 = remainingPages.length === 0;
    results.push({ name: `All pages closed (0 remaining, found ${remainingPages.length})`, pass: t7 });
    log('TEST', `Remaining pages: ${remainingPages.length} — ${t7 ? 'OK' : 'FAIL'}`);

    // Step 8: Print timing (already printed above)
    results.push({ name: `Close timing: ${closeDuration}ms total`, pass: true });

    ws.close();
    await sleep(3000);

  } catch (err) {
    console.error('Test error:', err);
    results.push({ name: 'Test execution', pass: false });
  }

  cleanup();

  // Step 9: Print summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n=== RESULTS ===');
  results.forEach(r => {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
  });
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
