#!/usr/bin/env node
'use strict';

/**
 * 多浏览器实例并发测试
 *
 * 验证"多 Chrome + 多 key + 服务端发现 + 隔离"完整链路：
 * 1. 起 proxy（REQUIRE_AUTH=true）
 * 2. 创建 keyA、keyB
 * 3. 启 ChromeA（扩展预设 keyA）+ 启 ChromeB（扩展预设 keyB）
 * 4. /json/browsers 返回 2 个浏览器（服务端发现）
 * 5. keyA 的 CDP createTarget + navigate → 打开百度
 * 6. keyB 的 CDP createTarget + navigate → 打开 example.com
 * 7. keyA 的 getTargets 看不到 keyB 的 tab（隔离）
 * 8. keyB 的 getTargets 看不到 keyA 的 tab（隔离）
 * 9. 并发操作互不干扰
 * 10. ChromeA 断开 → keyA 被拒，keyB 不受影响（容错）
 *
 * 关键技术点：两个 Chrome 加载各自的扩展副本（config.js 注入不同 key）。
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const KEY_MGR = path.resolve(__dirname, '../../server/saas/key-manager.js');

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function waitForPort(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { await httpGet(port, '/json/version'); return true; } catch { /* keep waiting */ }
    await sleep(500);
  }
  return false;
}

function createKey(name) {
  const out = execSync(`node ${KEY_MGR} create ${name}`, { encoding: 'utf8' });
  const m = out.match(/Key:\s*(cdp_\w+)/);
  return m ? m[1] : null;
}

/**
 * CDP 客户端：封装 WebSocket + 命令发送 + 响应匹配
 */
class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.idCounter = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((r, e) => { this.ws.on('open', r); this.ws.on('error', e); });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    return this;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.idCounter++;
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 30000);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

/**
 * 创建页面并导航：createTarget → attachToTarget → Page.navigate → 等加载
 */
async function createPageAndNavigate(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  // 用 sessionId 发 Page.navigate
  await client.send('Page.enable', {}, sessionId);
  await client.send('Page.navigate', { url }, sessionId);
  // 等 page 加载（轮询 Runtime.evaluate 直到 document.readyState !== 'loading'）
  for (let i = 0; i < 30; i++) {
    try {
      const result = await client.send('Runtime.evaluate', {
        expression: 'document.readyState'
      }, sessionId);
      if (result?.result?.value === 'complete') break;
    } catch {}
    await sleep(500);
  }
  return { targetId, sessionId };
}

// 重写 send 方法支持 sessionId
CdpClient.prototype.send = function(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = this.idCounter++;
    this.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 30000);
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
  });
};

function killChrome(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid); } catch {}
  if (proc._profile) {
    try { fs.rmSync(proc._profile, { recursive: true, force: true }); } catch {}
  }
  if (proc._tmpExt) {
    try { fs.rmSync(proc._tmpExt, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 启动一个 Chrome 实例（独立 profile + 独立扩展副本，config.js 注入指定 key）
 */
function launchChrome({ key, port, tag }) {
  const tmpExt = `/tmp/cdp-ext-${tag}-${Date.now()}`;
  fs.cpSync(EXTENSION_PATH, tmpExt, { recursive: true });
  const configPath = path.join(tmpExt, 'utils', 'config.js');
  const configOriginal = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(
    configPath,
    configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://127.0.0.1:${port}/plugin?key=${key}'`)
  );

  const profile = `/tmp/cdp-profile-${tag}-${Date.now()}`;
  const proc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${tmpExt}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    '--disable-features=DialMediaRouteProvider',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  proc._profile = profile;
  proc._tmpExt = tmpExt;
  return proc;
}

(async () => {
  let passed = 0, failed = 0;
  function ok(label, cond, extra) {
    cond ? (passed++, console.log(`[PASS] ${label}`)) : (failed++, console.log(`[FAIL] ${label}${extra ? ' → ' + extra : ''}`));
  }

  const PORT = 29700 + Math.floor(Math.random() * 500);
  const POOL_PORT = PORT + 1;
  const TK_PORT = PORT + 10;

  let proxyProc, chromeA, chromeB;
  let clientA, clientB;

  try {
    console.log('\n=== 多浏览器实例并发测试 ===\n');

    // ── Setup: 创建 keyA、keyB ──
    const KEY_A = createKey('multi-browser-A');
    const KEY_B = createKey('multi-browser-B');
    if (!KEY_A || !KEY_B) throw new Error('创建 key 失败');
    log('SETUP', `Key A: ${KEY_A.slice(0, 16)}...`);
    log('SETUP', `Key B: ${KEY_B.slice(0, 16)}...`);

    // ── Setup: 启动 proxy ──
    log('SETUP', `启动 proxy on port ${PORT}...`);
    proxyProc = spawn('node', [PROXY_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        POOL_START: String(POOL_PORT),
        POOL_SIZE: '3',
        TAKEOVER_PORT: String(TK_PORT),
        POOL_TAKEOVER_PORT: String(TK_PORT),
        REQUIRE_AUTH: 'true',
        LOG_LEVEL: 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stdout.on('data', () => {});
    proxyProc.stderr.on('data', () => {});
    if (!await waitForPort(PORT)) throw new Error('Proxy failed to start');
    log('SETUP', 'Proxy ready');

    // ── Setup: 启动 ChromeA（keyA）+ ChromeB（keyB）──
    log('SETUP', '启动 ChromeA (keyA)...');
    chromeA = launchChrome({ key: KEY_A, port: PORT, tag: 'A' });
    log('SETUP', '启动 ChromeB (keyB)...');
    chromeB = launchChrome({ key: KEY_B, port: PORT, tag: 'B' });

    // ── 等两个扩展都连上 ──
    log('SETUP', '等待两个浏览器连接...');
    let browsersReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const browsers = await httpGet(PORT, '/json/browsers');
        if (Array.isArray(browsers) && browsers.length >= 2) {
          browsersReady = true;
          log('SETUP', `两个浏览器都连上了`);
          break;
        }
      } catch {}
      await sleep(2000);
    }
    ok('服务端发现 2 个浏览器', browsersReady, browsersReady ? '' : '60s 内未连上 2 个');
    if (!browsersReady) throw new Error('浏览器未全部连上');

    // ── 连接 CDP 客户端 ──
    clientA = await new CdpClient(`ws://127.0.0.1:${PORT}/client?key=${KEY_A}`).connect();
    clientB = await new CdpClient(`ws://127.0.0.1:${PORT}/client?key=${KEY_B}`).connect();
    log('SETUP', '两个 CDP 客户端已连接');

    // ── Test 1: keyA 打开百度 ──
    console.log('\n[Test 1] keyA createTarget + navigate 百度');
    try {
      const { targetId, sessionId } = await createPageAndNavigate(clientA, 'https://www.baidu.com');
      const titleResult = await clientA.send('Runtime.evaluate', {
        expression: 'document.title'
      }, sessionId);
      const title = titleResult?.result?.value || '';
      log('TEST', `keyA 百度 title: "${title}"`);
      ok('keyA 打开百度', title.length > 0, `title="${title}"`);
    } catch (e) {
      ok('keyA 打开百度', false, e.message);
    }

    // ── Test 2: keyB 打开 example.com ──
    console.log('\n[Test 2] keyB createTarget + navigate example.com');
    try {
      const { targetId, sessionId } = await createPageAndNavigate(clientB, 'https://example.com');
      const titleResult = await clientB.send('Runtime.evaluate', {
        expression: 'document.title'
      }, sessionId);
      const title = titleResult?.result?.value || '';
      log('TEST', `keyB example.com title: "${title}"`);
      ok('keyB 打开 example.com', title.length > 0, `title="${title}"`);
    } catch (e) {
      ok('keyB 打开 example.com', false, e.message);
    }

    // ── Test 3: keyA 看不到 keyB 的 tab（隔离） ──
    console.log('\n[Test 3] keyA getTargets 看不到 keyB 的 tab');
    try {
      const tg = await clientA.send('Target.getTargets');
      const urls = (tg.targetInfos || []).filter(t => t.type === 'page').map(t => t.url);
      log('TEST', `keyA 看到的 page targets: ${JSON.stringify(urls)}`);
      const seesBaidu = urls.some(u => u.includes('baidu'));
      const seesExample = urls.some(u => u.includes('example.com'));
      ok('keyA 看到自己打开的百度', seesBaidu, `urls=${JSON.stringify(urls)}`);
      ok('keyA 看不到 keyB 的 example.com', !seesExample, `urls=${JSON.stringify(urls)}`);
    } catch (e) {
      ok('keyA getTargets 隔离', false, e.message);
    }

    // ── Test 4: keyB 看不到 keyA 的 tab（隔离） ──
    console.log('\n[Test 4] keyB getTargets 看不到 keyA 的 tab');
    try {
      const tg = await clientB.send('Target.getTargets');
      const urls = (tg.targetInfos || []).filter(t => t.type === 'page').map(t => t.url);
      log('TEST', `keyB 看到的 page targets: ${JSON.stringify(urls)}`);
      const seesBaidu = urls.some(u => u.includes('baidu'));
      const seesExample = urls.some(u => u.includes('example.com'));
      ok('keyB 看到自己打开的 example.com', seesExample, `urls=${JSON.stringify(urls)}`);
      ok('keyB 看不到 keyA 的百度', !seesBaidu, `urls=${JSON.stringify(urls)}`);
    } catch (e) {
      ok('keyB getTargets 隔离', false, e.message);
    }

    // ── Test 5: 并发操作互不干扰 ──
    console.log('\n[Test 5] 两个浏览器并发操作互不干扰');
    try {
      // 并发：A 和 B 各创建一个新 tab，注入不同的标记
      const [resA, resB] = await Promise.all([
        (async () => {
          const { sessionId } = await createPageAndNavigate(clientA, 'about:blank');
          return clientA.send('Runtime.evaluate', {
            expression: '(() => { document.title = "MARK-A"; return document.title; })()'
          }, sessionId);
        })(),
        (async () => {
          const { sessionId } = await createPageAndNavigate(clientB, 'about:blank');
          return clientB.send('Runtime.evaluate', {
            expression: '(() => { document.title = "MARK-B"; return document.title; })()'
          }, sessionId);
        })()
      ]);
      const markA = resA?.result?.value;
      const markB = resB?.result?.value;
      ok('并发操作：keyA 得到 MARK-A', markA === 'MARK-A', `got="${markA}"`);
      ok('并发操作：keyB 得到 MARK-B', markB === 'MARK-B', `got="${markB}"`);
    } catch (e) {
      ok('并发操作互不干扰', false, e.message);
    }

    // ── Test 6: ChromeA 断开后 keyA 被拒，keyB 不受影响 ──
    console.log('\n[Test 6] ChromeA 断开 → keyA 被拒，keyB 不受影响');
    try {
      // 关闭 CDP 客户端 A
      clientA.close();
      clientA = null;

      // 杀掉 ChromeA
      killChrome(chromeA);
      chromeA = null;
      await sleep(3000);

      // keyA 应该被拒（无浏览器）
      const keyARejected = await new Promise(resolve => {
        let settled = false;
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/client?key=${KEY_A}`);
        const done = r => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(r); } };
        ws.on('close', code => done({ rejected: true, code }));
        ws.on('error', () => done({ rejected: true, code: 'error' }));
        ws.on('open', () => setTimeout(() => done({ rejected: false, code: null }), 3000));
        setTimeout(() => done({ rejected: false, code: 'timeout' }), 8000);
      });
      ok('ChromeA 断开后 keyA 被拒', keyARejected.rejected, `code=${keyARejected.code}`);

      // keyB 应该还能正常用（创建新 tab + evaluate）
      const { sessionId } = await createPageAndNavigate(clientB, 'about:blank');
      const result = await clientB.send('Runtime.evaluate', {
        expression: '(() => { document.title = "STILL-ALIVE"; return document.title; })()'
      }, sessionId);
      const title = result?.result?.value;
      ok('ChromeA 断开后 keyB 不受影响', title === 'STILL-ALIVE', `title="${title}"`);
    } catch (e) {
      ok('ChromeA 断开容错', false, e.message);
    }

  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`);
    console.log(e.stack);
    failed++;
  } finally {
    try { if (clientA) clientA.close(); } catch {}
    try { if (clientB) clientB.close(); } catch {}
    try { if (chromeA) killChrome(chromeA); } catch {}
    try { if (chromeB) killChrome(chromeB); } catch {}
    try { proxyProc && proxyProc.kill('SIGTERM'); } catch {}
    try {
      const instanceDir = path.join(require('os').homedir(), '.cdp-tunnel', 'instances', String(PORT));
      fs.rmSync(instanceDir, { recursive: true, force: true });
    } catch {}

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
