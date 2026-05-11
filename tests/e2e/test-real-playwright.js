#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19237;
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
      /WS_URL:\s*'ws:\/\/localhost:9221\/plugin'/,
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

async function waitForExtension(port, maxWait = 45000) {
  await sleep(5000);
  let reqId = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const id = ++reqId;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off('message', handler);
          reject(new Error('timeout'));
        }, 5000);
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
        ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      });
      ws.close();
      if (result && result.targetInfos && result.targetInfos.length > 0) return true;
    } catch (e) {
      log('SETUP', `  Waiting for extension... (${e.message})`);
    }
    await sleep(3000);
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
  console.log('========================================');
  console.log('  Real Playwright Verification Test');
  console.log('  CDP Tunnel: http://localhost:' + PROXY_PORT);
  console.log('========================================\n');

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
    const userDataDir = `/tmp/pw-real-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
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

    // === Test 1: Single Playwright Connection ===
    console.log('\n--- Test 1: Single Connection ---');

    const browser1 = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    console.log('✅ Connected');

    const ctx1 = browser1.contexts()[0];
    console.log(`Contexts: ${browser1.contexts().length}, Pages: ${ctx1?.pages()?.length || 0}`);

    const page1 = await ctx1.newPage();
    console.log('✅ newPage()');

    await page1.goto('https://example.com', { timeout: 15000 });
    console.log(`✅ goto example.com: "${await page1.title()}"`);

    const h1 = await page1.$('h1');
    const h1Text = h1 ? await h1.textContent() : 'NOT FOUND';
    console.log(`✅ h1 element: "${h1Text}"`);

    const userAgent = await page1.evaluate(() => navigator.userAgent);
    console.log(`✅ User-Agent: ${userAgent.slice(0, 60)}...`);

    await page1.screenshot({ path: '/tmp/test-pw-page1.png' });
    console.log('✅ Screenshot saved to /tmp/test-pw-page1.png');

    // === Test 2: Second Concurrent Playwright Connection ===
    console.log('\n--- Test 2: Concurrent Connection ---');

    const browser2 = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    console.log('✅ Second browser connected');

    const ctx2 = browser2.contexts()[0];
    const ctx2Pages = ctx2?.pages()?.length || 0;
    console.log(`Browser 2 pages: ${ctx2Pages}`);

    const page2 = await ctx2.newPage();
    await page2.goto('https://example.org', { timeout: 15000 });
    console.log(`✅ Browser 2 navigated: "${await page2.title()}"`);

    const ctx1PagesNow = ctx1.pages().length;
    console.log(`Browser 1 pages: ${ctx1PagesNow} (should be same as before)`);

    // === Test 3: Element Interaction ===
    console.log('\n--- Test 3: Element Interaction ---');

    const page3 = await ctx1.newPage();
    await page3.goto('https://example.com', { timeout: 15000 });

    const links = await page3.$$('a');
    console.log(`✅ Found ${links.length} links on page`);

    if (links.length > 0) {
      const firstLinkText = await links[0].textContent();
      const firstLinkHref = await links[0].getAttribute('href');
      console.log(`  First link: "${firstLinkText?.trim()}" -> ${firstLinkHref}`);
    }

    const metrics = await page3.evaluate(() => ({
      title: document.title,
      url: window.location.href,
      width: window.innerWidth,
      height: window.innerHeight,
      domNodes: document.querySelectorAll('*').length
    }));
    console.log(`✅ Page metrics: ${metrics.domNodes} DOM nodes, ${metrics.width}x${metrics.height}`);

    // === Test 4: Multiple Pages ===
    console.log('\n--- Test 4: Multiple Pages ---');

    const pages = [];
    for (let i = 0; i < 3; i++) {
      const p = await ctx1.newPage();
      await p.goto('https://example.com', { timeout: 15000, waitUntil: 'domcontentloaded' });
      pages.push(p);
      console.log(`  Created page ${i + 1}/3`);
    }
    console.log(`✅ Created ${pages.length} additional pages`);
    console.log(`  Total pages in context: ${ctx1.pages().length}`);

    for (const p of pages) {
      await p.close();
    }
    console.log(`✅ Closed all additional pages`);
    console.log(`  Remaining pages: ${ctx1.pages().length}`);

    // === Test 5: CDP Session ===
    console.log('\n--- Test 5: CDP Session ---');

    const cdpSession = await ctx1.newCDPSession(page3);
    const { result } = await cdpSession.send('Runtime.evaluate', { expression: 'document.title' });
    console.log(`✅ CDP Runtime.evaluate: "${result.value}"`);

    const targets = await cdpSession.send('Target.getTargets');
    console.log(`✅ CDP Target.getTargets: ${targets.targetInfos.length} targets`);
    targets.targetInfos.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.type}: ${t.url?.slice(0, 50) || 'unknown'}`);
    });

    // === Cleanup ===
    console.log('\n--- Cleanup ---');

    await page1.close();
    await page3.close();
    await browser1.close();
    console.log('✅ Browser 1 closed');

    await page2.close();
    await browser2.close();
    console.log('✅ Browser 2 closed');

    cleanup();

    console.log('\n========================================');
    console.log('  ALL TESTS PASSED ✅');
    console.log('========================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
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
