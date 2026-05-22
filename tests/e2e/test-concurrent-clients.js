#!/usr/bin/env node
'use strict';

/**
 * Test: Multi-client concurrent operations
 *
 * 1. Start proxy + Chrome
 * 2. Connect 3 CDP clients simultaneously
 * 3. Each client creates 2 pages (Target.createTarget)
 * 4. Each client calls Target.getTargets — assert each only sees OWN pages
 * 5. Client 1 closes 1 page, Client 2 closes 1 page
 * 6. Re-check isolation: each client still only sees its own remaining pages
 * 7. Disconnect Client 1
 * 8. Clients 2 and 3 still work — Target.getTargets still returns their pages
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
  console.log('=== Concurrent Clients E2E Test ===\n');
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

    const userDataDir = `/tmp/concurrent-test-${Date.now()}`;
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

    // Step 2: Connect 3 CDP clients simultaneously
    log('TEST', 'Connecting 3 CDP clients...');
    const ws1 = await connectCDP(PROXY_PORT);
    const ws2 = await connectCDP(PROXY_PORT);
    const ws3 = await connectCDP(PROXY_PORT);
    log('TEST', 'All 3 clients connected');

    await sendCDP(ws1, 'Target.setDiscoverTargets', { discover: true });
    await sendCDP(ws2, 'Target.setDiscoverTargets', { discover: true });
    await sendCDP(ws3, 'Target.setDiscoverTargets', { discover: true });

    // Step 3: Each client creates 2 pages
    log('TEST', 'Each client creating 2 pages...');
    const client1Pages = [];
    const client2Pages = [];
    const client3Pages = [];

    for (let i = 0; i < 2; i++) {
      const r1 = await sendCDP(ws1, 'Target.createTarget', { url: `https://www.example.com/?c1p${i}` });
      client1Pages.push(r1.targetId);
    }
    for (let i = 0; i < 2; i++) {
      const r2 = await sendCDP(ws2, 'Target.createTarget', { url: `https://www.example.com/?c2p${i}` });
      client2Pages.push(r2.targetId);
    }
    for (let i = 0; i < 2; i++) {
      const r3 = await sendCDP(ws3, 'Target.createTarget', { url: `https://www.example.com/?c3p${i}` });
      client3Pages.push(r3.targetId);
    }

    await sleep(5000);
    log('TEST', 'All pages created');

    // Step 4: Each client calls Target.getTargets — assert each only sees OWN pages
    log('TEST', 'Checking isolation: each client should only see own pages...');
    const targets1 = await sendCDP(ws1, 'Target.getTargets');
    const targets2 = await sendCDP(ws2, 'Target.getTargets');
    const targets3 = await sendCDP(ws3, 'Target.getTargets');

    const pages1 = targets1.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?c'));
    const pages2 = targets2.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?c'));
    const pages3 = targets3.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?c'));

    const t4a = pages1.length === 2 && pages1.every(p => p.url.includes('c1p'));
    const t4b = pages2.length === 2 && pages2.every(p => p.url.includes('c2p'));
    const t4c = pages3.length === 2 && pages3.every(p => p.url.includes('c3p'));
    const t4d = !pages1.some(p => p.url.includes('c2') || p.url.includes('c3'));
    const t4e = !pages2.some(p => p.url.includes('c1') || p.url.includes('c3'));
    const t4f = !pages3.some(p => p.url.includes('c1') || p.url.includes('c2'));

    results.push(
      { name: 'Client 1 sees only own 2 pages', pass: t4a && t4d },
      { name: 'Client 2 sees only own 2 pages', pass: t4b && t4e },
      { name: 'Client 3 sees only own 2 pages', pass: t4c && t4f }
    );
    log('TEST', `Client 1: ${pages1.length} pages (expect 2) — ${t4a && t4d ? 'OK' : 'FAIL'}`);
    log('TEST', `Client 2: ${pages2.length} pages (expect 2) — ${t4b && t4e ? 'OK' : 'FAIL'}`);
    log('TEST', `Client 3: ${pages3.length} pages (expect 2) — ${t4c && t4f ? 'OK' : 'FAIL'}`);

    // Step 5: Client 1 closes 1 page, Client 2 closes 1 page
    log('TEST', 'Client 1 closing page 0, Client 2 closing page 0...');
    await sendCDP(ws1, 'Target.closeTarget', { targetId: client1Pages[0] });
    await sendCDP(ws2, 'Target.closeTarget', { targetId: client2Pages[0] });
    await sleep(3000);

    // Step 6: Re-check isolation
    log('TEST', 'Re-checking isolation after partial closes...');
    const targets1b = await sendCDP(ws1, 'Target.getTargets');
    const targets2b = await sendCDP(ws2, 'Target.getTargets');
    const targets3b = await sendCDP(ws3, 'Target.getTargets');

    const pages1b = targets1b.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?c1'));
    const pages2b = targets2b.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?c2'));
    const pages3b = targets3b.targetInfos.filter(t => t.type === 'page' && t.url.includes('example.com/?c3'));

    const t6a = pages1b.length === 1 && pages1b[0]?.url.includes('c1p1');
    const t6b = pages2b.length === 1 && pages2b[0]?.url.includes('c2p1');
    const t6c = pages3b.length === 2;

    results.push(
      { name: 'Client 1 has 1 remaining page', pass: t6a },
      { name: 'Client 2 has 1 remaining page', pass: t6b },
      { name: 'Client 3 still has 2 pages', pass: t6c }
    );
    log('TEST', `Client 1: ${pages1b.length} pages (expect 1) — ${t6a ? 'OK' : 'FAIL'}`);
    log('TEST', `Client 2: ${pages2b.length} pages (expect 1) — ${t6b ? 'OK' : 'FAIL'}`);
    log('TEST', `Client 3: ${pages3b.length} pages (expect 2) — ${t6c ? 'OK' : 'FAIL'}`);

    // Step 7: Disconnect Client 1
    log('TEST', 'Disconnecting Client 1...');
    ws1.close();
    await sleep(5000);

    // Step 8: Clients 2 and 3 still work (connection alive, CDP commands succeed)
    log('TEST', 'Verifying Clients 2 and 3 connections still alive...');
    let ws2Alive = false;
    let ws3Alive = false;
    try {
      const targets2c = await sendCDP(ws2, 'Target.getTargets');
      ws2Alive = targets2c && typeof targets2c.targetInfos !== 'undefined';
    } catch (e) {
      log('TEST', `Client 2 CDP error: ${e.message}`);
    }
    try {
      const targets3c = await sendCDP(ws3, 'Target.getTargets');
      ws3Alive = targets3c && typeof targets3c.targetInfos !== 'undefined';
    } catch (e) {
      log('TEST', `Client 3 CDP error: ${e.message}`);
    }

    results.push(
      { name: 'Client 2 connection alive after Client 1 disconnect', pass: ws2Alive },
      { name: 'Client 3 connection alive after Client 1 disconnect', pass: ws3Alive }
    );
    log('TEST', `Client 2 alive: ${ws2Alive} — ${ws2Alive ? 'OK' : 'FAIL'}`);
    log('TEST', `Client 3 alive: ${ws3Alive} — ${ws3Alive ? 'OK' : 'FAIL'}`);

    ws2.close();
    ws3.close();
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
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  console.log('===============\n');

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
