#!/usr/bin/env node
'use strict';

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

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(8000);
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
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: Direct Group Creation Verification (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-group-creation-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    // 1. Connect CDP client
    log('CDP', 'Connecting CDP client...');
    const ws = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    log('CDP', 'Connected');

    // 2. Create a CDP tab
    log('CDP', 'Creating tab via Target.createTarget...');
    const createResult = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
    const tabTargetId = createResult?.result?.targetId;
    log('CDP', `Created tab targetId: ${tabTargetId}`);

    if (!tabTargetId) {
      log('FAIL', 'No targetId returned from Target.createTarget');
      failed++;
      ws.close();
      cleanup();
      console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
      process.exit(1);
      return;
    }

    // 3. Wait for group assignment (the setTimeout in addTabToAutomationGroup)
    log('WAIT', 'Waiting 5s for group assignment...');
    await sleep(5000);

    // 4. Query group info via Tab.getGroupInfo
    log('CHECK', 'Querying Tab.getGroupInfo...');
    const groupResult = await sendCDP(ws, 'Tab.getGroupInfo');
    const { groupId, baseName, clientId } = groupResult?.result || {};
    log('CHECK', `clientId=${clientId}, groupId=${groupId}, baseName=${baseName}`);

    // 5. Assert: groupId is not null/undefined
    if (groupId != null) {
      log('PASS', `Tab group created successfully: groupId=${groupId}, baseName=${baseName}`);
      passed++;
    } else {
      log('FAIL', `No groupId assigned (clientId=${clientId}, baseName=${baseName})`);
      failed++;
    }

    // 6. Disconnect
    log('DISC', 'Disconnecting...');
    ws.close();
    await sleep(8000);

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
