#!/usr/bin/env node
'use strict';

/**
 * Test: Long connection stability (3 minutes)
 *
 * 1. Start proxy + Chrome
 * 2. Connect CDP client, create 3 pages
 * 3. Every 30 seconds for 3 minutes (6 iterations):
 *    - Send Target.getTargets
 *    - Verify page count is still correct
 *    - Print status: "Heartbeat N/6: OK (3 pages)"
 * 4. After 3 minutes, verify connection still alive
 * 5. Close everything
 * 6. Print PASS/FAIL summary
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

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_COUNT = 6;
const EXPECTED_PAGES = 3;

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
  console.log('=== Long Connection Stability E2E Test (3 min) ===\n');
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

    const userDataDir = `/tmp/long-conn-test-${Date.now()}`;
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

    // Step 2: Connect CDP client, create 3 pages
    const ws = await connectCDP(PROXY_PORT);
    await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
    log('TEST', 'CDP client connected');

    const pageIds = [];
    for (let i = 0; i < EXPECTED_PAGES; i++) {
      const r = await sendCDP(ws, 'Target.createTarget', { url: `https://www.example.com/?longtest${i}` });
      pageIds.push(r.targetId);
    }
    log('TEST', `Created ${EXPECTED_PAGES} pages`);
    await sleep(3000);

    const testStart = Date.now();

    // Step 3: Every 30 seconds for 3 minutes (6 iterations)
    for (let i = 1; i <= HEARTBEAT_COUNT; i++) {
      if (i > 1) {
        log('TEST', `Waiting ${HEARTBEAT_INTERVAL / 1000}s before heartbeat ${i}/${HEARTBEAT_COUNT}...`);
        await sleep(HEARTBEAT_INTERVAL);
      }

      try {
        const targets = await sendCDP(ws, 'Target.getTargets');
        const myPages = targets.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?longtest'));
        const ok = myPages.length === EXPECTED_PAGES;

        log('TEST', `Heartbeat ${i}/${HEARTBEAT_COUNT}: ${ok ? 'OK' : 'FAIL'} (${myPages.length} pages)`);
        results.push({ name: `Heartbeat ${i}/${HEARTBEAT_COUNT}: ${myPages.length} pages`, pass: ok });
      } catch (e) {
        log('TEST', `Heartbeat ${i}/${HEARTBEAT_COUNT}: FAIL (${e.message})`);
        results.push({ name: `Heartbeat ${i}/${HEARTBEAT_COUNT}`, pass: false });
      }
    }

    const totalDuration = Date.now() - testStart;
    log('TEST', `Heartbeat loop completed in ${totalDuration}ms`);

    // Step 4: Verify connection still alive
    log('TEST', 'Verifying connection still alive after 3 minutes...');
    const finalTargets = await sendCDP(ws, 'Target.getTargets');
    const finalPages = finalTargets.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?longtest'));
    const alive = finalPages.length === EXPECTED_PAGES;
    results.push({ name: `Connection alive after 3 min (${finalPages.length} pages)`, pass: alive });
    log('TEST', `Final check: ${finalPages.length} pages — ${alive ? 'OK' : 'FAIL'}`);

    // Step 5: Close everything
    log('TEST', 'Closing all test pages...');
    for (const targetId of pageIds) {
      try { await sendCDP(ws, 'Target.closeTarget', { targetId }); } catch {}
    }
    ws.close();
    await sleep(3000);

  } catch (err) {
    console.error('Test error:', err);
    results.push({ name: 'Test execution', pass: false });
  }

  cleanup();

  // Step 6: Print summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n=== RESULTS ===');
  results.forEach(r => {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
  });
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  console.log('===============\n');

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
