#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19235;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let originalConfig = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let _requestId = 0;

function sendCDP(ws, method, params) {
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
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
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
  _requestId = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const result = await Promise.race([
        sendCDP(ws, 'Target.getTargets'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      ws.close();
      _requestId = 0;
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
    try { process.kill(-chromeProcess.pid); } catch {}
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

async function runTest() {
  console.log('=== Auto-Mute E2E Test ===\n');
  let passed = 0;
  let failed = 0;

  try {
    patchConfig(PROXY_PORT);
    log('SETUP', 'Patched extension config');

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', (d) => {
      const s = d.toString().trim();
      if (s) log('PROXY-ERR', s.substring(0, 120));
    });
    log('SETUP', `Proxy started (PID: ${proxyProcess.pid})`);

    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy did not become ready');
    log('SETUP', 'Proxy is ready');

    const userDataDir = `/tmp/mute-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;
    log('SETUP', `Chrome started (PID: ${chromeProcess.pid})`);

    log('SETUP', 'Waiting for extension to connect...');
    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    const ws = await connectCDP(PROXY_PORT);

    await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    log('TEST1', 'Creating new tab via Target.createTarget...');
    const createResult = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
    const targetId = createResult.targetId;
    if (!targetId) throw new Error('Failed to create target');
    log('TEST1', `Tab created: ${targetId}`);

    await sleep(3000);

    log('TEST1', 'Checking mute status via Tab.getMuteStatus...');
    const muteResult = await sendCDP(ws, 'Tab.getMuteStatus', { cdpOnly: true });

    const cdpTabs = muteResult.tabs || [];
    log('TEST1', `Got ${cdpTabs.length} CDP tabs`);
    cdpTabs.forEach(t => log('TEST1', `  Tab ${t.id}: muted=${t.muted} url=${t.url}`));

    const ourTab = cdpTabs.find(t => t.muted);
    if (ourTab) {
      log('TEST1', `✅ Tab ${ourTab.id} is MUTED`);
      passed++;
    } else {
      log('TEST1', '❌ No CDP tab is muted');
      failed++;
    }

    log('TEST2', 'Creating 3 more tabs...');
    const tabIds = [];
    for (let i = 0; i < 3; i++) {
      const res = await sendCDP(ws, 'Target.createTarget', { url: `about:blank#tab${i}` });
      if (res.targetId) tabIds.push(res.targetId);
      await sleep(500);
    }
    log('TEST2', `Created ${tabIds.length} additional tabs`);

    await sleep(3000);

    const muteResult2 = await sendCDP(ws, 'Tab.getMuteStatus', { cdpOnly: true });
    const cdpTabs2 = muteResult2.tabs || [];
    const cdpCreatedTabs = cdpTabs2.filter(t => t.url !== 'about:blank' || t.muted);
    const mutedCreatedCount = cdpTabs2.filter(t => t.muted).length;
    log('TEST2', `${mutedCreatedCount}/${cdpTabs2.length} CDP tabs are muted`);

    if (mutedCreatedCount >= cdpTabs2.length - 1 && cdpTabs2.length > 1) {
      log('TEST2', '✅ All CDP-created tabs are muted (initial tab excluded)');
      passed++;
    } else {
      log('TEST2', `❌ Only ${mutedCreatedCount}/${cdpTabs2.length} tabs are muted`);
      cdpTabs2.forEach(t => log('TEST2', `  Tab ${t.id}: muted=${t.muted} url=${t.url}`));
      failed++;
    }

    log('TEST3', 'Verifying Tab.getMuteStatus without cdpOnly filter...');
    const muteResult3 = await sendCDP(ws, 'Tab.getMuteStatus', {});
    const allTabs = muteResult3.tabs || [];
    log('TEST3', `Total tabs reported: ${allTabs.length}`);
    allTabs.forEach(t => log('TEST3', `  Tab ${t.id}: muted=${t.muted} url=${t.url}`));
    if (allTabs.length > 0) {
      log('TEST3', '✅ Tab.getMuteStatus returns all tabs');
      passed++;
    } else {
      log('TEST3', '❌ Tab.getMuteStatus returned no tabs');
      failed++;
    }

    ws.close();
    cleanup();

    try {
      if (chromeProcess?._profile) {
        fs.rmSync(chromeProcess._profile, { recursive: true, force: true });
      }
    } catch {}

    console.log('\n=== RESULTS ===');
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    console.log('==============\n');
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('Test error:', err);
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
