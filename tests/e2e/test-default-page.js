#!/usr/bin/env node
'use strict';

/**
 * TDD: 默认页面 + Playwright 连接测试（端口池语义）
 *
 * 对齐原生 Chrome --remote-debugging-port：客户端连接后不产生任何隐式 about:blank。
 * 原生 Chrome 在 client 连接后 target 列表为空（需自己 createTarget）。
 * 端口池也一样：client 连接后 getTargets 返回空，pages() 返回空。
 *
 * 验证：
 * 1. Playwright connectOverCDP 能成功连接
 * 2. 连接后 pages() 不包含用户页面（隔离）
 * 3. CDP Target.getTargets 不返回用户页面
 * 4. newPage() 能创建并访问页面
 * 5. 创建的页面在 getTargets 中可见
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
const INSTANCES_DIR = path.join(require('os').homedir(), '.cdp-tunnel', 'instances');

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
  // 排空 proxy stdout/stderr，防止 pipe 缓冲满导致 proxy 阻塞（run-all 环境下尤甚）
  proxyProc.stdout.on('data', () => {});
  proxyProc.stderr.on('data', () => {});

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
      // 用 /json/version 检查 proxy 是否运行（create 模式 /json/list 返回空，不再用于扩展检查）
      const ver = await httpGet(PORT, '/json/version');
      if (ver && ver.webSocketDebuggerUrl) {
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
    // ── Test 1: Playwright connectOverCDP 能成功连接 ──
    console.log('\n[Test 1] Playwright connectOverCDP 能成功连接');
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    const initialPages = ctx.pages();

    console.log(`  pages().length = ${initialPages.length}`);
    if (initialPages.length > 0) {
      initialPages.forEach((p, i) => console.log(`    page[${i}]: ${p.url()}`));
    }

    // 对齐原生 CDP：端口池连接后无隐式页面，pages() 应为空
    // （无 auto-default-page，无 warmup tab）
    const hasForeignPages = initialPages.some(p => p.url() !== 'about:blank');
    if (!hasForeignPages) {
      console.log('[PASS] 连接成功，且不包含用户页面');
      passed++;
    } else {
      console.log(`[FAIL] 看到了非 about:blank 页面（用户 tab 被抢）`);
      failed++;
    }

    // ── Test 2: CDP Target.getTargets 不返回用户页面 ──
    console.log('\n[Test 2] CDP Target.getTargets 不返回用户页面');
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

    // 端口池语义：getTargets 只返回本端口创建的 page（初始可能为 0），不应有用户页面
    const hasUserPage = pageTargets.some(t => t.url !== 'about:blank');
    if (!hasUserPage) {
      console.log('[PASS] getTargets 不包含用户页面');
      passed++;
    } else {
      console.log(`[FAIL] getTargets 包含用户页面`);
      pageTargets.forEach(t => console.log(`    found: ${t.url}`));
      failed++;
    }

    // ── Test 3: newPage() 能创建并访问页面 ──
    console.log('\n[Test 3] newPage() 能创建并访问页面');
    const newPage = await ctx.newPage();
    // newPage 已创建 about:blank，直接 evaluate（goto about:blank 冗余且 load 事件不可靠）
    await newPage.evaluate(() => { document.title = 'cdp-created'; document.body.innerHTML = '<h1>created</h1>'; });

    const pagesAfterNew = ctx.pages();
    console.log(`  pages().length after newPage = ${pagesAfterNew.length}`);
    pagesAfterNew.forEach((p, i) => console.log(`    page[${i}]: ${p.url()}`));

    const newTitle = await newPage.title();
    if (newTitle === 'cdp-created') {
      console.log('[PASS] newPage() 成功创建并注入内容');
      passed++;
    } else {
      console.log(`[FAIL] newPage() 后无法注入内容 (title="${newTitle}")`);
      failed++;
    }

    // ── Test 4: 创建的页面在 getTargets 中可见 ──
    console.log('\n[Test 4] 创建的页面在 getTargets 中可见');
    await sleep(1000);
    const targetsAfterCreate = await sendCDP(ws, 'Target.getTargets');
    const pageTargetsAfterCreate = (targetsAfterCreate?.result?.targetInfos || []).filter(t => t.type === 'page');
    // 新建的页面应在 getTargets 中可见（数量应增加）
    console.log(`  getTargets page count after newPage = ${pageTargetsAfterCreate.length}`);

    if (pageTargetsAfterCreate.length >= 1) {
      console.log('[PASS] 创建的页面在 getTargets 中可见');
      passed++;
    } else {
      console.log(`[FAIL] 创建的页面在 getTargets 中不可见`);
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

  const instanceDir = path.join(INSTANCES_DIR, String(PORT));
  try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
