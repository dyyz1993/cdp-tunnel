#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const PROXY_PORT = 19236;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const STATE_FILE = path.join(os.homedir(), '.cdp-tunnel', 'extension-state.json');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11,19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

async function waitForProxy(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => { ws.on('open', () => { ws.close(); resolve(); }); ws.on('error', reject); });
      return true;
    } catch { await sleep(500); }
  }
  return false;
}

async function waitForPlugin(port, maxWait = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(data);
      if (state.connected && (Date.now() - state.lastSeen) < 10000) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function runTest() {
  console.log('=== Test: Playwright with EXISTING pages ===\n');
  let passed = 0, failed = 0;

  try {
    patchConfig(PROXY_PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy failed');

    const userDataDir = `/tmp/existing-pages-test-${Date.now()}`;
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

    if (!await waitForPlugin(PROXY_PORT, 25000)) throw new Error('Plugin failed');
    log('SETUP', 'Chrome + extension ready');

    log('SETUP', 'Creating 3 existing pages via raw CDP...');
    const ws = new WebSocket(`ws://localhost:${PROXY_PORT}/client`);
    await new Promise(r => ws.on('open', r));
    const existingIds = [];
    for (let i = 0; i < 3; i++) {
      const id = Date.now() + i;
      ws.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url: 'about:blank' } }));
      const resp = await new Promise(r => {
        ws.on('message', function handler(data) {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) { ws.removeListener('message', handler); r(msg); }
        });
      });
      if (resp.result?.targetId) existingIds.push(resp.result.targetId);
      await sleep(500);
    }
    log('SETUP', `Created ${existingIds.length} existing pages`);
    ws.close();
    await sleep(2000);

    log('TEST', 'Connecting Playwright...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`, { timeout: 15000 });
    log('TEST', 'Connected');

    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    log('TEST', `Existing pages: ${pages.length}`);
    if (pages.length > 0) {
      log('TEST', `PASS: pages() returned ${pages.length} pages`);
      passed++;
    } else {
      log('TEST', `FAIL: pages() empty`);
      failed++;
    }

    log('TEST', 'Creating new page...');
    try {
      const newPage = await ctx.newPage();
      log('TEST', 'PASS: newPage() - no Duplicate target error');
      passed++;
      await newPage.goto('about:blank');
      log('TEST', 'PASS: goto');
      passed++;
      await newPage.close();
      log('TEST', 'PASS: close');
      passed++;
    } catch (err) {
      log('TEST', `FAIL: ${err.message}`);
      failed++;
    }

    await browser.close();
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    proxyProcess.kill('SIGINT');
    restoreConfig();

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('FATAL:', err.message);
    try { if (chromeProcess) process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    proxyProcess?.kill('SIGINT');
    restoreConfig();
    process.exit(1);
  }
}

runTest();
