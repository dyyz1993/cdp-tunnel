#!/usr/bin/env node
'use strict';

/**
 * TDD: 默认 about:blank 页面测试
 *
 * 当 CDP 客户端连接到 cdp-tunnel 时，系统应自动创建一个默认的
 * about:blank 页面并加入客户端的 automation group。
 * 这与原生 Chrome CDP 行为一致（连接后即有一个默认 about:blank 页面）。
 *
 * 验证：
 * 1. Playwright 连接后，pages() 应有 1 个默认 about:blank 页面
 * 2. 该页面 url 为 about:blank
 * 3. CDP Target.getTargets 确认默认页面归属该客户端
 * 4. newPage() 后应有 2 个页面，默认页面仍存在
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
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

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.random();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout: ${method}`));
    }, 15000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function killChrome(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid); } catch {}
  if (proc._profile) {
    try { fs.rmSync(proc._profile, { recursive: true, force: true }); } catch {}
  }
}

function killProxy(proc) {
  if (!proc) return;
  try { proc.kill('SIGINT'); } catch {}
}

(async () => {
  let passed = 0, failed = 0;
  const PORT = 10000 + Math.floor(Math.random() * 50000);

  log('SETUP', `Using port ${PORT}`);

  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`)
  );

  const proxyProc = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (!await waitForPort(PORT)) {
    console.log('[FAIL] Proxy failed to start');
    killProxy(proxyProc);
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  log('SETUP', 'Proxy ready');

  const profile = `/tmp/cdp-default-page-${Date.now()}`;
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  chromeProc._profile = profile;

  await sleep(8000);
  let extReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpGet(PORT, '/json/list');
      if ((list || []).filter(t => t.type === 'page').length > 0) {
        extReady = true;
        break;
      }
    } catch {}
    await sleep(2000);
  }

  if (!extReady) {
    console.log('[FAIL] Extension not connected');
    killChrome(chromeProc);
    killProxy(proxyProc);
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  log('SETUP', 'Extension connected');
  await sleep(2000);

  try {
    // ── Test 1: 连接后应有 1 个默认 about:blank 页面 ──
    console.log('\n[Test 1] Playwright 连接后应有 1 个默认 about:blank 页面');
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    const initialPages = ctx.pages();

    console.log(`  pages().length = ${initialPages.length}`);
    if (initialPages.length > 0) {
      initialPages.forEach((p, i) => console.log(`    page[${i}]: ${p.url()}`));
    }

    if (initialPages.length === 1) {
      console.log('[PASS] 连接后恰好有 1 个页面');
      passed++;
    } else {
      console.log(`[FAIL] 期望 1 个页面，实际 ${initialPages.length} 个`);
      failed++;
    }

    // ── Test 2: 默认页面 URL 为 about:blank ──
    console.log('\n[Test 2] 默认页面 URL 为 about:blank');
    if (initialPages.length >= 1) {
      const defaultUrl = initialPages[0].url();
      console.log(`  default page url = ${defaultUrl}`);

      if (defaultUrl === 'about:blank') {
        console.log('[PASS] 默认页面 URL 是 about:blank');
        passed++;
      } else {
        console.log(`[FAIL] 默认页面 URL 是 "${defaultUrl}"，期望 "about:blank"`);
        failed++;
      }
    } else {
      console.log('[SKIP] 没有页面可检查');
      failed++;
    }

    // ── Test 3: CDP Target.getTargets 确认默认页面归属该客户端 ──
    console.log('\n[Test 3] CDP Target.getTargets 确认默认页面归属该客户端');
    const ws = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });

    await sendCDP(ws, 'Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true
    });
    await sleep(1000);

    const targetsResult = await sendCDP(ws, 'Target.getTargets');
    const pageTargets = (targetsResult?.result?.targetInfos || []).filter(t => t.type === 'page');

    console.log(`  getTargets page count = ${pageTargets.length}`);
    pageTargets.forEach(t => console.log(`    ${t.targetId.substring(0, 8)} ${t.url.substring(0, 40)}`));

    if (pageTargets.length >= 1) {
      const hasBlank = pageTargets.some(t => t.url === 'about:blank');
      if (hasBlank) {
        console.log('[PASS] Target.getTargets 包含 about:blank 页面，归属该客户端');
        passed++;
      } else {
        console.log('[FAIL] Target.getTargets 不包含 about:blank 页面');
        pageTargets.forEach(t => console.log(`    found: ${t.url}`));
        failed++;
      }
    } else {
      console.log(`[FAIL] getTargets 返回 ${pageTargets.length} 个 page（期望 >= 1）`);
      failed++;
    }

    // ── Test 4: newPage() 后应有 2 个页面 ──
    console.log('\n[Test 4] newPage() 后应有 2 个页面');
    const newPage = await ctx.newPage();
    await newPage.goto('https://www.example.com', { timeout: 15000 });

    const pagesAfterNew = ctx.pages();
    console.log(`  pages().length after newPage = ${pagesAfterNew.length}`);
    pagesAfterNew.forEach((p, i) => console.log(`    page[${i}]: ${p.url()}`));

    if (pagesAfterNew.length === 2) {
      console.log('[PASS] newPage() 后恰好有 2 个页面');
      passed++;
    } else {
      console.log(`[FAIL] 期望 2 个页面，实际 ${pagesAfterNew.length} 个`);
      failed++;
    }

    // ── Test 5: 默认页面仍然存在且可访问 ──
    console.log('\n[Test 5] 默认页面仍然存在且可访问');
    const defaultPageStillExists = pagesAfterNew.some(
      p => p.url() === 'about:blank'
    );

    if (defaultPageStillExists) {
      const blankPage = pagesAfterNew.find(p => p.url() === 'about:blank');
      const title = await blankPage.title().catch(() => '');
      console.log(`  default page still accessible, title="${title}"`);
      console.log('[PASS] 默认 about:blank 页面仍然存在且可访问');
      passed++;
    } else {
      console.log('[FAIL] 默认 about:blank 页面消失了');
      failed++;
    }

    ws.close();
    await browser.close();
  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`);
    failed++;
  }

  killChrome(chromeProc);
  killProxy(proxyProc);
  fs.writeFileSync(CONFIG_PATH, configOriginal);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
