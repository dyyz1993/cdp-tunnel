#!/usr/bin/env node
'use strict';

/**
 * Test: Long connection stability (3 minutes)
 *
 * 1. Start proxy + Chrome
 * 2. Connect CDP client
 * 3. Create 3 pages
 * 4. Every 30s for 3 minutes (6 iterations), send Target.getTargets
 * 5. Verify pages persist, connection stays alive
 * 6. Close everything
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19233;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

const ITERATIONS = 6;
const INTERVAL_MS = 30_000;
const TOTAL_WAIT_MS = ITERATIONS * INTERVAL_MS;

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
  console.log(`=== Long Connection Stability Test (${ITERATIONS} x ${INTERVAL_MS / 1000}s = ${TOTAL_WAIT_MS / 1000}s) ===\n`);
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

    const userDataDir = `/tmp/long-conn-test-${Date.now()}`;
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

    // Create 3 pages
    log('TEST', 'Creating 3 pages...');
    const pageIds = [];
    for (let i = 0; i < 3; i++) {
      const r = await sendCDP(ws, 'Target.createTarget', { url: `about:blank#long_${i}` });
      pageIds.push(r.targetId);
    }
    await sleep(3000);
    log('TEST', `Created ${pageIds.length} pages`);

    // Monitor for disconnections
    let disconnected = false;
    ws.on('close', () => {
      disconnected = true;
      log('HEARTBEAT', '⚠️ WebSocket disconnected!');
    });
    ws.on('error', (err) => {
      log('HEARTBEAT', `⚠️ WebSocket error: ${err.message}`);
    });

    // === Heartbeat loop: 6 iterations x 30s ===
    log('HEARTBEAT', `Starting ${ITERATIONS}-iteration heartbeat check (${TOTAL_WAIT_MS / 1000}s total)...`);
    const testStart = Date.now();

    for (let i = 1; i <= ITERATIONS; i++) {
      await sleep(INTERVAL_MS);

      if (disconnected) {
        throw new Error(`WebSocket disconnected before iteration ${i}`);
      }

      const targets = await sendCDP(ws, 'Target.getTargets');
      const myPages = targets.targetInfos.filter(t =>
        t.type === 'page' && pageIds.includes(t.targetId)
      );
      const elapsed = ((Date.now() - testStart) / 1000).toFixed(0);

      assert(myPages.length === pageIds.length,
        `Iteration ${i}: expected ${pageIds.length} pages, found ${myPages.length}`);

      log('HEARTBEAT',
        `✅ Iteration ${i}/${ITERATIONS} @ ${elapsed}s — ` +
        `${myPages.length} pages present, ws alive, no disconnect`
      );
    }

    passed++;
    log('TEST', `✅ Connection stable for ${TOTAL_WAIT_MS / 1000}s across ${ITERATIONS} iterations`);

    // Final check: all pages still accessible
    const finalTargets = await sendCDP(ws, 'Target.getTargets');
    const finalPages = finalTargets.targetInfos.filter(t =>
      t.type === 'page' && pageIds.includes(t.targetId)
    );
    assert(finalPages.length === pageIds.length,
      `Final: expected ${pageIds.length}, found ${finalPages.length}`);
    passed++;
    log('TEST', '✅ All pages still accessible after 3 minutes');

    // Close
    for (const pid of pageIds) {
      await sendCDP(ws, 'Target.closeTarget', { targetId: pid });
    }
    ws.close();

    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}/2, Failed: ${failed}`);
    console.log(`Total wait: ${TOTAL_WAIT_MS / 1000}s (${ITERATIONS} x ${INTERVAL_MS / 1000}s)`);
    console.log('===============\n');

    cleanup();
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Test error:', err);
    failed++;
    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}/2, Failed: ${failed}`);
    console.log('===============\n');
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
