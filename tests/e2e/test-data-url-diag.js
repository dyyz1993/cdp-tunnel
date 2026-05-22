#!/usr/bin/env node
'use strict';

/**
 * 精确诊断 data: URL 导航失败问题
 * 逐步测试，定位是哪一步出了问题
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_TUNNEL_PORT = 29221;
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
function restoreConfig() { if (configOriginal) { fs.writeFileSync(CONFIG_PATH, configOriginal); configOriginal = null; } }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function waitForProxy(port) {
  for (let i = 0; i < 20; i++) { try { await httpGet(port, '/json/version'); return true; } catch { await sleep(500); } }
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
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} chromeProcess = null; }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} proxyProcess = null; }
  restoreConfig();
}

async function main() {
  console.log('=== Diagnostic: data: URL navigation issue ===\n');

  try {
    patchConfig(CDP_TUNNEL_PORT);
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(CDP_TUNNEL_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (!await waitForProxy(CDP_TUNNEL_PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-diag-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(CDP_TUNNEL_PORT)) throw new Error('Extension failed');
    await sleep(2000);

    log('TEST', 'Connecting Playwright to cdp-tunnel...');
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_TUNNEL_PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    log('TEST', `Connected. Initial pages: ${ctx.pages().length}`);

    // Test 1: Use the FIRST existing page for data: URL
    log('TEST', '\n--- Test 1: Navigate EXISTING page to data: URL ---');
    const existingPage = ctx.pages()[0];
    if (existingPage) {
      log('TEST', `Existing page URL: ${existingPage.url()}`);
      try {
        await existingPage.goto('data:text/html,<h1>hello-existing</h1>', { timeout: 10000 });
        const h1 = await existingPage.evaluate(() => document.querySelector('h1')?.textContent);
        log('RESULT', `Test 1: SUCCESS h1="${h1}"`);
      } catch (e) {
        log('RESULT', `Test 1: FAILED - ${e.message.substring(0, 100)}`);
      }
    }

    // Test 2: Create a new page and navigate to data: URL
    log('TEST', '\n--- Test 2: NEW page + goto(data:) ---');
    try {
      const page2 = await ctx.newPage();
      log('TEST', `New page URL: ${page2.url()}`);
      await page2.goto('data:text/html,<h1>hello-new</h1>', { timeout: 10000 });
      const h1 = await page2.evaluate(() => document.querySelector('h1')?.textContent);
      log('RESULT', `Test 2: SUCCESS h1="${h1}"`);
      await page2.close();
    } catch (e) {
      log('RESULT', `Test 2: FAILED - ${e.message.substring(0, 100)}`);
    }

    // Test 3: New page + setContent
    log('TEST', '\n--- Test 3: NEW page + setContent ---');
    try {
      const page3 = await ctx.newPage();
      await page3.setContent('<h1>hello-setContent</h1>', { timeout: 10000 });
      const h1 = await page3.evaluate(() => document.querySelector('h1')?.textContent);
      log('RESULT', `Test 3: SUCCESS h1="${h1}"`);
      await page3.close();
    } catch (e) {
      log('RESULT', `Test 3: FAILED - ${e.message.substring(0, 100)}`);
    }

    // Test 4: New page + goto https first, then data:
    log('TEST', '\n--- Test 4: NEW page + goto(https) then goto(data:) ---');
    try {
      const page4 = await ctx.newPage();
      await page4.goto('https://www.example.com', { timeout: 10000 });
      log('TEST', `After https: ${page4.url()}`);
      await page4.goto('data:text/html,<h1>hello-after-https</h1>', { timeout: 10000 });
      const h1 = await page4.evaluate(() => document.querySelector('h1')?.textContent);
      log('RESULT', `Test 4: SUCCESS h1="${h1}"`);
      await page4.close();
    } catch (e) {
      log('RESULT', `Test 4: FAILED - ${e.message.substring(0, 100)}`);
    }

    // Test 5: evaluate directly on about:blank (no navigation)
    log('TEST', '\n--- Test 5: NEW page + evaluate on about:blank ---');
    try {
      const page5 = await ctx.newPage();
      await page5.evaluate(() => { document.body.innerHTML = '<h1>hello-eval</h1>'; });
      const h1 = await page5.evaluate(() => document.querySelector('h1')?.textContent);
      log('RESULT', `Test 5: SUCCESS h1="${h1}"`);
      await page5.close();
    } catch (e) {
      log('RESULT', `Test 5: FAILED - ${e.message.substring(0, 100)}`);
    }

    // Test 6: Raw CDP Page.navigate to data: URL
    log('TEST', '\n--- Test 6: Raw CDP Page.navigate to data: ---');
    try {
      const page6 = await ctx.newPage();
      const cdpSession = await page6.context().newCDPSession(page6);
      await cdpSession.send('Page.enable');
      const navResult = await cdpSession.send('Page.navigate', { url: 'data:text/html,<h1>hello-cdp</h1>' });
      log('TEST', `Page.navigate result: ${JSON.stringify(navResult)}`);
      await sleep(2000);
      const h1 = await page6.evaluate(() => document.querySelector('h1')?.textContent);
      log('RESULT', `Test 6: SUCCESS h1="${h1}"`);
      await page6.close();
    } catch (e) {
      log('RESULT', `Test 6: FAILED - ${e.message.substring(0, 100)}`);
    }

    await browser.close();
  } catch (err) {
    console.error('\nFATAL:', err.message);
  } finally {
    cleanup();
  }
}

main();
