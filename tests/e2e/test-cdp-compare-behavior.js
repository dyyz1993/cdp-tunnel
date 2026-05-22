#!/usr/bin/env node
'use strict';

/**
 * 对比测试：原生 CDP (9222) vs cdp-tunnel (9221)
 * 
 * 同一个 Chrome 实例同时开启两个 CDP 端口：
 *   - 9222: 原生 --remote-debugging-port
 *   - 9221: cdp-tunnel proxy + extension
 * 
 * 用同样的 Playwright 代码分别连接，对比行为是否一致。
 * 
 * 测试项：
 *   1. pages() 初始页面数
 *   2. ctx.newPage() 创建新页面
 *   3. page.addInitScript() 注入脚本
 *   4. page.goto() + page.evaluate() 执行 JS
 *   5. page.on('console') 监听控制台
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_TUNNEL_PORT = 19221;
const NATIVE_CDP_PORT = 19222;
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
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
    /WS_URL:\s*'[^']*'/,
    `WS_URL: 'ws://localhost:${port}/plugin'`
  ));
}

function restoreConfig() {
  if (configOriginal) { fs.writeFileSync(CONFIG_PATH, configOriginal); configOriginal = null; }
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function waitForProxy(port) {
  for (let i = 0; i < 20; i++) {
    try { await httpGet(port, '/json/version'); return true; } catch { await sleep(500); }
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
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} chromeProcess = null; }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} proxyProcess = null; }
  restoreConfig();
}

async function runTestsOnPort(label, port) {
  const results = { label, tests: [], success: true };
  const t = (name, passed, detail) => {
    results.tests.push({ name, passed, detail });
    log(label, `${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) results.success = false;
  };

  let browser;
  try {
    log(label, `Connecting to port ${port}...`);
    browser = await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 20000 });
    log(label, 'Connected');
  } catch (e) {
    log(label, `CONNECTION FAILED: ${e.message}`);
    t('connect', false, e.message);
    return results;
  }

  try {
    const contexts = browser.contexts();
    log(label, `contexts: ${contexts.length}`);
    t('contexts > 0', contexts.length > 0, `count=${contexts.length}`);

    if (contexts.length === 0) {
      t('pages visible', false, 'no contexts');
      await browser.close();
      return results;
    }

    const ctx = contexts[0];
    const initialPages = ctx.pages();
    log(label, `initial pages: ${initialPages.length}`);
    t('initial pages >= 1', initialPages.length >= 1, `count=${initialPages.length}`);

    if (initialPages.length > 0) {
      initialPages.forEach((p, i) => log(label, `  page[${i}]: ${p.url()}`));
    }

    // Test: newPage
    log(label, 'Testing ctx.newPage()...');
    let newPage;
    try {
      newPage = await ctx.newPage();
      t('newPage() works', !!newPage, `url=${newPage?.url()}`);
    } catch (e) {
      t('newPage() works', false, e.message);
      await browser.close();
      return results;
    }

    const pagesAfterCreate = ctx.pages();
    log(label, `pages after newPage: ${pagesAfterCreate.length}`);
    t('pages increased after newPage', pagesAfterCreate.length > initialPages.length,
      `before=${initialPages.length} after=${pagesAfterCreate.length}`);

    // Test: addInitScript + evaluate
    log(label, 'Testing addInitScript + evaluate...');
    try {
      await newPage.addInitScript(() => {
        window.__CDP_TEST_INJECTED = 'injected-value-' + Date.now();
      });
      t('addInitScript() succeeds', true);
    } catch (e) {
      t('addInitScript() succeeds', false, e.message);
    }

    try {
      await newPage.goto('https://www.example.com', { timeout: 10000 });
      t('goto(https) succeeds', true);
    } catch (e) {
      t('goto(https) succeeds', false, e.message);
    }

    try {
      const val = await newPage.evaluate(() => window.__CDP_TEST_INJECTED);
      t('evaluate() returns injected value', val?.startsWith('injected-value-'), `value=${val}`);
    } catch (e) {
      t('evaluate() returns injected value', false, e.message);
    }

    // Test: console listener (set up listener BEFORE evaluate)
    log(label, 'Testing console listener...');
    try {
      const consoleMessages = [];
      newPage.on('console', msg => consoleMessages.push(msg.text()));
      await newPage.evaluate(() => console.log('__CDP_CONSOLE_TEST__'));
      await sleep(500);
      const found = consoleMessages.some(m => m.includes('__CDP_CONSOLE_TEST__'));
      t('console listener works', found, `messages=${JSON.stringify(consoleMessages)}`);
    } catch (e) {
      t('console listener works', false, e.message);
    }

    // Test: page.content()
    try {
      const content = await newPage.content();
      t('page.content() works', content.length > 0, `length=${content.length}`);
    } catch (e) {
      t('page.content() works', false, e.message);
    }

    await browser.close();
  } catch (e) {
    log(label, `UNEXPECTED ERROR: ${e.message}`);
    results.success = false;
    try { await browser.close(); } catch {}
  }

  return results;
}

async function main() {
  console.log('=== CDP Behavior Compare: Native (9222) vs cdp-tunnel (9221) ===\n');

  try {
    patchConfig(CDP_TUNNEL_PORT);

    // Start cdp-tunnel proxy
    log('SETUP', 'Starting cdp-tunnel proxy...');
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(CDP_TUNNEL_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (!await waitForProxy(CDP_TUNNEL_PORT)) throw new Error('Proxy failed');
    log('SETUP', 'Proxy ready');

    // Launch Chrome with BOTH native CDP and extension
    const profile = `/tmp/cdp-compare-test-${Date.now()}`;
    log('SETUP', 'Launching Chrome...');
    chromeProcess = spawn(CHROME_PATH, [
      `--remote-debugging-port=${NATIVE_CDP_PORT}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    // Wait for native CDP
    log('SETUP', 'Waiting for native CDP...');
    if (!await waitForProxy(NATIVE_CDP_PORT)) throw new Error('Native CDP failed');
    log('SETUP', 'Native CDP ready');

    // Wait for extension to connect to proxy
    log('SETUP', 'Waiting for extension...');
    if (!await waitForExtension(CDP_TUNNEL_PORT)) throw new Error('Extension failed');
    log('SETUP', 'Extension connected');

    await sleep(2000);

    // Show /json/list for both
    log('INFO', '--- /json/list comparison ---');
    try {
      const nativeList = await httpGet(NATIVE_CDP_PORT, '/json/list');
      const tunnelList = await httpGet(CDP_TUNNEL_PORT, '/json/list');
      const nativePages = nativeList.filter(t => t.type === 'page');
      const tunnelPages = tunnelList.filter(t => t.type === 'page');
      log('INFO', `Native /json/list: ${nativePages.length} pages`);
      nativePages.forEach(p => log('INFO', `  [native] ${p.id?.substring(0, 12)} ${p.url}`));
      log('INFO', `Tunnel /json/list: ${tunnelPages.length} pages`);
      tunnelPages.forEach(p => log('INFO', `  [tunnel] ${p.id?.substring(0, 12)} ${p.url}`));
    } catch (e) {
      log('WARN', `Failed to get /json/list: ${e.message}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('  PHASE 1: Native CDP (port 9222)');
    console.log('='.repeat(60) + '\n');
    const nativeResults = await runTestsOnPort('NATIVE', NATIVE_CDP_PORT);

    await sleep(3000);

    console.log('\n' + '='.repeat(60));
    console.log('  PHASE 2: cdp-tunnel (port 9221)');
    console.log('='.repeat(60) + '\n');
    const tunnelResults = await runTestsOnPort('TUNNEL', CDP_TUNNEL_PORT);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('  COMPARISON SUMMARY');
    console.log('='.repeat(60));

    const allTests = new Set();
    nativeResults.tests.forEach(t => allTests.add(t.name));
    tunnelResults.tests.forEach(t => allTests.add(t.name));

    console.log('\n| Test | Native (9222) | Tunnel (9221) | Match? |');
    console.log('|------|---------------|---------------|--------|');

    let matchCount = 0;
    let totalTests = 0;
    for (const name of allTests) {
      const n = nativeResults.tests.find(t => t.name === name);
      const t = tunnelResults.tests.find(t => t.name === name);
      const nStatus = n ? (n.passed ? 'PASS' : 'FAIL') : 'N/A';
      const tStatus = t ? (t.passed ? 'PASS' : 'FAIL') : 'N/A';
      const match = nStatus === tStatus;
      if (n || t) totalTests++;
      if (match && n) matchCount++;
      console.log(`| ${name} | ${nStatus} | ${tStatus} | ${match ? 'YES' : '** NO **'} |`);
    }

    console.log(`\nOverall: ${matchCount}/${totalTests} behaviors match`);
    console.log(`Native:  ${nativeResults.success ? 'ALL PASS' : 'HAS FAILURES'}`);
    console.log(`Tunnel:  ${tunnelResults.success ? 'ALL PASS' : 'HAS FAILURES'}`);

  } catch (err) {
    console.error('\nFATAL:', err.message);
    console.error(err.stack);
  } finally {
    cleanup();
  }
}

main();
