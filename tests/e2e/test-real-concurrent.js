#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    configOriginal.replace(
      /WS_URL:\s*'ws:\/\/localhost:\d+\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (configOriginal) {
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    configOriginal = null;
  }
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 15000) {
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
  console.log('=== Concurrent Playwright Test ===\n');

  try {
    // === Setup ===
    log('SETUP', 'Patching extension config...');
    patchConfig(PROXY_PORT);

    log('SETUP', 'Starting proxy server...');
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => {
        if (l.includes('ERROR')) log('PROXY-ERR', l);
      });
    });

    log('SETUP', `Proxy started (PID: ${proxyProcess.pid})`);

    if (!await waitForProxy(PROXY_PORT)) {
      throw new Error('Proxy did not become ready');
    }
    log('SETUP', 'Proxy is ready');

    log('SETUP', 'Starting Chrome with extension...');
    const userDataDir = `/tmp/pw-concurrent-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      '--headless=new',
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;
    log('SETUP', `Chrome started (PID: ${chromeProcess.pid})`);

    log('SETUP', 'Waiting for extension to connect...');
    if (!await waitForExtension(PROXY_PORT)) {
      throw new Error('Extension did not connect');
    }
    log('SETUP', 'Extension connected!');

    await sleep(2000);

    const CDP_URL = `http://localhost:${PROXY_PORT}`;

    console.log('Connecting 3 browsers...');
    const browser1 = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    const browser2 = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    const browser3 = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    console.log('✅ 3 browsers connected');

    // Each browser creates pages and navigates concurrently
    console.log('Each browser creating pages...');
    async function browserTask(browser, label) {
      var contexts = browser.contexts();
      var ctx;
      if (contexts.length > 0) {
        ctx = contexts[0];
        try { await ctx.pages(); } catch (e) { ctx = null; }
      }
      if (!ctx) {
        ctx = await browser.newContext();
      }
      return ctx;
    }
    const results = await Promise.all([
      (async () => {
        const ctx = await browserTask(browser1, 'browser1');
        const page = await ctx.newPage();
        await page.goto('https://example.com', { timeout: 15000, waitUntil: 'domcontentloaded' });
        const title = await page.title();
        await page.close();
        return { browser: 1, title };
      })(),
      (async () => {
        const ctx = await browserTask(browser2, 'browser2');
        const page = await ctx.newPage();
        await page.goto('https://example.com', { timeout: 15000, waitUntil: 'domcontentloaded' });
        const title = await page.title();
        await page.close();
        return { browser: 2, title };
      })(),
      (async () => {
        const ctx = await browserTask(browser3, 'browser3');
        const page = await ctx.newPage();
        await page.goto('https://example.com', { timeout: 15000, waitUntil: 'domcontentloaded' });
        const title = await page.title();
        await page.close();
        return { browser: 3, title };
      })(),
    ]);

    results.forEach(r => console.log(`  Browser ${r.browser}: "${r.title}"`));
    console.log('✅ All 3 browsers navigated concurrently');

    // Verify isolation
    console.log('Verifying isolation...');
    const pages1 = browser1.contexts()[0]?.pages()?.length || 0;
    const pages2 = browser2.contexts()[0]?.pages()?.length || 0;
    const pages3 = browser3.contexts()[0]?.pages()?.length || 0;
    console.log(`  Browser 1 pages: ${pages1}, Browser 2: ${pages2}, Browser 3: ${pages3}`);

    // Cleanup
    await Promise.all([browser1.close(), browser2.close(), browser3.close()]);
    console.log('✅ All browsers closed');

    cleanup();

    console.log('\n=== CONCURRENT TEST PASSED ✅ ===\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAILED:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

runTest();
