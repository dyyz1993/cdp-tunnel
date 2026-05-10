#!/usr/bin/env node
'use strict';

/**
 * Test: Multi-client concurrent operations isolation
 *
 * 1. Start proxy + Chrome
 * 2. Connect 3 CDP clients simultaneously
 * 3. Each client creates 3 pages concurrently
 * 4. Each client navigates its pages to different URLs
 * 5. Verify each client only sees its OWN pages (isolation)
 * 6. Close pages selectively, verify isolation holds
 * 7. Disconnect client 1, verify 2 & 3 still work
 * 8. Verify no cross-contamination
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19231;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

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
  console.log('=== Concurrent Clients E2E Test ===\n');
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

    const userDataDir = `/tmp/concurrent-test-${Date.now()}`;
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

    // === Step 1: Connect 3 clients ===
    log('TEST', 'Connecting 3 CDP clients...');
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const ws = await connectCDP(PROXY_PORT);
      await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
      clients.push({ ws, id: i, label: `Client${i}`, pages: [] });
      log('TEST', `  Client ${i} connected`);
    }

    // === Step 2: Each client creates 3 pages concurrently ===
    log('TEST', 'Each client creating 3 pages concurrently...');
    const urls = [
      ['about:blank#c1_0', 'about:blank#c1_1', 'about:blank#c1_2'],
      ['about:blank#c2_0', 'about:blank#c2_1', 'about:blank#c2_2'],
      ['about:blank#c3_0', 'about:blank#c3_1', 'about:blank#c3_2'],
    ];

    const createPromises = clients.map((client, ci) => {
      return Promise.all(urls[ci].map(async (url) => {
        const r = await sendCDP(client.ws, 'Target.createTarget', { url });
        client.pages.push(r.targetId);
        return r.targetId;
      }));
    });
    await Promise.all(createPromises);
    await sleep(3000);

    clients.forEach(c => log('TEST', `  ${c.label} created ${c.pages.length} pages`));

    // === Step 3: Verify isolation - each client only sees own pages ===
    log('TEST', 'Verifying isolation: each client sees only own pages...');
    for (const client of clients) {
      const targets = await sendCDP(client.ws, 'Target.getTargets');
      const myPages = targets.targetInfos.filter(t =>
        t.type === 'page' && t.url.includes(`#c${client.id + 1}`)
      );
      const otherPages = targets.targetInfos.filter(t =>
        t.type === 'page' && t.url.includes('#c') && !t.url.includes(`#c${client.id + 1}`)
      );

      assert(myPages.length === 3,
        `${client.label} should see 3 own pages, got ${myPages.length}`);
      assert(otherPages.length === 0,
        `${client.label} should NOT see other clients' pages, found ${otherPages.length}`);
      log('TEST', `  ${client.label}: sees ${myPages.length} own pages, ${otherPages.length} others' — OK`);
    }
    passed++;
    log('TEST', '✅ Isolation verified for all 3 clients');

    // === Step 4: Selective page closes ===
    log('TEST', 'Closing pages: Client0 closes 1, Client1 closes 2, Client2 closes all');
    await sendCDP(clients[0].ws, 'Target.closeTarget', { targetId: clients[0].pages[0] });
    clients[0].pages.shift();

    await sendCDP(clients[1].ws, 'Target.closeTarget', { targetId: clients[1].pages[0] });
    await sendCDP(clients[1].ws, 'Target.closeTarget', { targetId: clients[1].pages[1] });
    clients[1].pages.splice(0, 2);

    for (const pid of clients[2].pages) {
      await sendCDP(clients[2].ws, 'Target.closeTarget', { targetId: pid });
    }
    clients[2].pages = [];

    await sleep(3000);

    // === Step 5: Verify isolation still holds after closes ===
    log('TEST', 'Verifying isolation after closes...');
    for (const client of clients) {
      const targets = await sendCDP(client.ws, 'Target.getTargets');
      const myPages = targets.targetInfos.filter(t =>
        t.type === 'page' && t.url.includes(`#c${client.id + 1}`)
      );
      const otherPages = targets.targetInfos.filter(t =>
        t.type === 'page' && t.url.includes('#c') && !t.url.includes(`#c${client.id + 1}`)
      );

      assert(myPages.length === client.pages.length,
        `${client.label} should have ${client.pages.length} pages, got ${myPages.length}`);
      assert(otherPages.length === 0,
        `${client.label} should still see 0 other pages, found ${otherPages.length}`);
      log('TEST', `  ${client.label}: ${myPages.length} own, ${otherPages.length} others' — OK`);
    }
    passed++;
    log('TEST', '✅ Isolation holds after selective closes');

    // === Step 6: Disconnect client 0, verify others still work ===
    log('TEST', 'Disconnecting Client0...');
    clients[0].ws.close();
    await sleep(5000);

    for (const client of [clients[1], clients[2]]) {
      const targets = await sendCDP(client.ws, 'Target.getTargets');
      assert(targets.targetInfos !== undefined, `${client.label} should still be functional`);
      const myPages = targets.targetInfos.filter(t =>
        t.type === 'page' && t.url.includes(`#c${client.id + 1}`)
      );
      assert(myPages.length === client.pages.length,
        `${client.label} pages unchanged after Client0 disconnect: expected ${client.pages.length}, got ${myPages.length}`);
      log('TEST', `  ${client.label}: still functional with ${myPages.length} pages — OK`);
    }
    passed++;
    log('TEST', '✅ Client1 and Client2 unaffected after Client0 disconnect');

    // Cleanup remaining clients
    clients[1].ws.close();
    clients[2].ws.close();

    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}/3, Failed: ${failed}`);
    console.log('===============\n');

    cleanup();
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Test error:', err);
    failed++;
    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}/3, Failed: ${failed}`);
    console.log('===============\n');
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
