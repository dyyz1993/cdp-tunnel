#!/usr/bin/env node
'use strict';

/**
 * 纯净对比测试：
 *   Round 1: 纯 Chrome（无扩展）+ 原生 CDP (--remote-debugging-port)
 *   Round 2: Chrome + 扩展 + cdp-tunnel proxy
 * 
 * 同样的 Playwright 用例，对比行为是否一致。
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function waitForPort(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { await httpGet(port, '/json/version'); return true; } catch { await sleep(500); }
  }
  return false;
}

function killChrome(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid); } catch {}
  if (proc._profile) { try { fs.rmSync(proc._profile, { recursive: true, force: true }); } catch {} }
}

function killProxy(proc) {
  if (!proc) return;
  try { proc.kill('SIGINT'); } catch {}
}

async function runTests(label, port) {
  const results = [];
  const t = (name, passed, detail) => {
    results.push({ name, passed, detail });
    log(label, `${passed ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  };

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 20000 });
  } catch (e) {
    log(label, `CONNECTION FAILED: ${e.message}`);
    t('connect', false, e.message);
    return results;
  }

  try {
    const ctx = browser.contexts()[0];
    if (!ctx) { t('has context', false, 'no contexts'); return results; }
    t('has context', true);

    const initialPages = ctx.pages();
    t('initial pages ok', initialPages.length >= 0, `count=${initialPages.length}`);
    if (initialPages.length > 0) {
      initialPages.forEach((p, i) => log(label, `  page[${i}]: ${p.url()}`));
    }

    // newPage + addInitScript + goto + evaluate
    const page = await ctx.newPage();
    t('newPage()', true, `url=${page.url()}`);

    await page.addInitScript(() => {
      window.__CDP_TEST = 'injected-' + Date.now();
    });
    t('addInitScript()', true);

    await page.goto('https://www.example.com', { timeout: 15000 });
    t('goto(https)', true, page.url());

    const val = await page.evaluate(() => window.__CDP_TEST);
    t('evaluate(injected)', val?.startsWith('injected-'), `value=${val}`);

    const title = await page.title();
    t('page.title()', !!title, `title=${title}`);

    // console
    const msgs = [];
    page.on('console', m => msgs.push(m.text()));
    await page.evaluate(() => console.log('__TEST_CONSOLE__'));
    await sleep(500);
    t('console event', msgs.some(m => m.includes('__TEST_CONSOLE__')), `count=${msgs.length}`);

    // content
    const html = await page.content();
    t('page.content()', html.length > 100, `length=${html.length}`);

    // screenshot
    const ss = await page.screenshot();
    t('screenshot()', ss.length > 0, `size=${ss.length} bytes`);

    // evaluate complex
    const computed = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasBody: !!document.body
    }));
    t('evaluate(complex)', computed.hasBody && computed.url.includes('example'), JSON.stringify(computed));

    // wait for selector
    await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {});
    const h1Text = await page.evaluate(() => document.querySelector('h1')?.textContent);
    t('waitForSelector + extract', !!h1Text, `h1=${h1Text}`);

    await browser.close();
  } catch (e) {
    log(label, `ERROR: ${e.message}`);
    t('no unexpected errors', false, e.message.substring(0, 120));
    try { await browser.close(); } catch {}
  }

  return results;
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Round 1: 纯 Chrome + 原生 CDP (无扩展)');
  console.log('='.repeat(60) + '\n');

  const nativePort = 39222;
  const nativeProfile = `/tmp/cdp-native-test-${Date.now()}`;
  let nativeChrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${nativePort}`,
    `--user-data-dir=${nativeProfile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  nativeChrome._profile = nativeProfile;

  if (!await waitForPort(nativePort)) {
    log('NATIVE', 'Chrome failed to start');
    killChrome(nativeChrome);
    process.exit(1);
  }
  log('NATIVE', `Chrome ready on port ${nativePort}`);

  const nativeResults = await runTests('NATIVE', nativePort);
  killChrome(nativeChrome);
  await sleep(2000);

  console.log('\n' + '='.repeat(60));
  console.log('  Round 2: Chrome + 扩展 + cdp-tunnel');
  console.log('='.repeat(60) + '\n');

  const tunnelPort = 39221;
  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${tunnelPort}/plugin'`));

  let proxyProcess = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(tunnelPort), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (!await waitForPort(tunnelPort)) {
    log('TUNNEL', 'Proxy failed');
    killProxy(proxyProcess);
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  log('TUNNEL', `Proxy ready on port ${tunnelPort}`);

  const tunnelProfile = `/tmp/cdp-tunnel-test-${Date.now()}`;
  let tunnelChrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${tunnelProfile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  tunnelChrome._profile = tunnelProfile;

  // Wait for extension
  await sleep(6000);
  let extReady = false;
  for (let i = 0; i < 20; i++) {
    try {
      const list = await httpGet(tunnelPort, '/json/list');
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) { extReady = true; break; }
    } catch {}
    await sleep(2000);
  }
  if (!extReady) {
    log('TUNNEL', 'Extension failed');
    killChrome(tunnelChrome);
    killProxy(proxyProcess);
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  log('TUNNEL', 'Extension connected');
  await sleep(2000);

  const tunnelResults = await runTests('TUNNEL', tunnelPort);

  killChrome(tunnelChrome);
  killProxy(proxyProcess);
  fs.writeFileSync(CONFIG_PATH, configOriginal);

  // Compare
  console.log('\n' + '='.repeat(60));
  console.log('  COMPARISON: 纯 Chrome vs cdp-tunnel');
  console.log('='.repeat(60) + '\n');

  const allNames = [...new Set([
    ...nativeResults.map(r => r.name),
    ...tunnelResults.map(r => r.name)
  ])];

  console.log('| Test | Native CDP | cdp-tunnel | Match? |');
  console.log('|------|------------|------------|--------|');

  let match = 0, total = 0;
  for (const name of allNames) {
    const n = nativeResults.find(r => r.name === name);
    const t = tunnelResults.find(r => r.name === name);
    const ns = n ? (n.passed ? 'PASS' : 'FAIL') : '-';
    const ts = t ? (t.passed ? 'PASS' : 'FAIL') : '-';
    const m = ns === ts;
    total++;
    if (m) match++;
    console.log(`| ${name} | ${ns} | ${ts} | ${m ? 'YES' : '** NO **'} |`);
  }

  console.log(`\nResult: ${match}/${total} match`);

  if (match === total) {
    console.log('\n*** ALL BEHAVIORS IDENTICAL ***\n');
  } else {
    console.log('\n*** DIFFERENCES FOUND ***\n');
  }

  process.exit(match === total ? 0 : 1);
}

main();
