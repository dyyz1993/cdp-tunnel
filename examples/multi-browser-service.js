'use strict';

/**
 * 多浏览器实例服务示例
 *
 * 场景：一台服务器同时管理多个远程浏览器
 * - 服务方启动 cdp-tunnel proxy（REQUIRE_AUTH=true）
 * - 为每个用户创建一个 API Key（一 key = 一浏览器实例）
 * - 用户在自己电脑装扩展 + 填 pluginUrl
 * - 服务方用 clientUrl 通过 Playwright/CDP 接管浏览器
 *
 * 运行：node examples/multi-browser-service.js
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// === 配置 ===
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'extension-new');
const PROXY_PATH = path.join(PROJECT_ROOT, 'server/proxy-server.js');
const KEY_MGR = path.join(PROJECT_ROOT, 'server/saas/key-manager.js');

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

// === Key 管理 ===
function createKey(name) {
  const out = execSync(`node ${KEY_MGR} create ${name}`, { encoding: 'utf8' });
  const m = out.match(/Key:\s*(cdp_\w+)/);
  return m ? m[1] : null;
}

// === CDP 客户端（轻量封装） ===
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
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.idCounter++;
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); } }, 30000);
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// === 浏览器操作辅助 ===
async function createPageAndNavigate(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 30; i++) {
    try {
      const result = await client.send('Runtime.evaluate', { expression: 'document.readyState' }, sessionId);
      if (result?.result?.value === 'complete') break;
    } catch {}
    await sleep(500);
  }
  return { targetId, sessionId };
}

// === Chrome 启动（带扩展 + key 预设） ===
function launchChrome({ key, port, tag }) {
  // 复制扩展到临时目录，注入 key
  const tmpExt = `/tmp/cdp-ext-${tag}-${Date.now()}`;
  fs.cpSync(EXTENSION_PATH, tmpExt, { recursive: true });
  const configPath = path.join(tmpExt, 'utils', 'config.js');
  const configOriginal = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, configOriginal.replace(
    /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://127.0.0.1:${port}/plugin?key=${key}'`
  ));

  const profile = `/tmp/cdp-profile-${tag}-${Date.now()}`;
  const proc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${tmpExt}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  proc._profile = profile;
  proc._tmpExt = tmpExt;
  return proc;
}

function killChrome(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid); } catch {}
  if (proc._profile) { try { fs.rmSync(proc._profile, { recursive: true, force: true }); } catch {} }
  if (proc._tmpExt) { try { fs.rmSync(proc._tmpExt, { recursive: true, force: true }); } catch {} }
}

// ============================================================
// 主流程：模拟多浏览器实例服务
// ============================================================
(async () => {
  const PORT = 29700 + Math.floor(Math.random() * 500);
  let proxyProc, chromeA, chromeB, clientA, clientB;

  try {
    console.log('\n=== 多浏览器实例服务示例 ===\n');

    // Step 1: 启动 proxy（强制鉴权）
    log('SERVICE', `启动 cdp-tunnel proxy on port ${PORT}...`);
    proxyProc = spawn('node', [PROXY_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        POOL_SIZE: '3',
        POOL_START: String(PORT + 1),
        TAKEOVER_PORT: String(PORT + 10),
        POOL_TAKEOVER_PORT: String(PORT + 10),
        REQUIRE_AUTH: 'true',
        LOG_LEVEL: 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stdout.on('data', () => {});
    proxyProc.stderr.on('data', () => {});
    if (!await waitForPort(PORT)) throw new Error('Proxy 启动失败');
    log('SERVICE', 'Proxy 就绪');

    // Step 2: 为两个用户创建 Key
    const KEY_A = createKey('用户A');
    const KEY_B = createKey('用户B');
    log('SERVICE', `用户A 的 Key: ${KEY_A?.slice(0, 20)}...`);
    log('SERVICE', `用户B 的 Key: ${KEY_B?.slice(0, 20)}...`);
    log('SERVICE', `用户A 的扩展连接地址: ws://your-server:${PORT}/plugin?key=${KEY_A}`);
    log('SERVICE', `用户B 的扩展连接地址: ws://your-server:${PORT}/plugin?key=${KEY_B}`);

    // Step 3: 启动两个 Chrome（模拟用户装扩展 + 配置 key）
    log('BROWSER', '启动用户A 的 Chrome...');
    chromeA = launchChrome({ key: KEY_A, port: PORT, tag: 'A' });
    log('BROWSER', '启动用户B 的 Chrome...');
    chromeB = launchChrome({ key: KEY_B, port: PORT, tag: 'B' });

    // Step 4: 等待两个浏览器上线（服务端发现）
    log('SERVICE', '等待浏览器连接...');
    for (let i = 0; i < 60; i++) {
      try {
        const browsers = await httpGet(PORT, '/json/browsers');
        if (Array.isArray(browsers) && browsers.length >= 2) {
          log('SERVICE', `发现 ${browsers.length} 个在线浏览器`);
          break;
        }
      } catch {}
      await sleep(2000);
    }

    // Step 5: 用 CDP 接管两个浏览器
    log('CDP', '连接用户A 的浏览器...');
    clientA = await new CdpClient(`ws://127.0.0.1:${PORT}/client?key=${KEY_A}`).connect();
    log('CDP', '连接用户B 的浏览器...');
    clientB = await new CdpClient(`ws://127.0.0.1:${PORT}/client?key=${KEY_B}`).connect();

    // Step 6: 分别操作两个浏览器
    log('CDP', '用户A 的浏览器打开百度...');
    const { sessionId: sessA } = await createPageAndNavigate(clientA, 'https://www.baidu.com');
    const titleA = (await clientA.send('Runtime.evaluate', { expression: 'document.title' }, sessA))?.result?.value;
    log('CDP', `用户A 百度 title: "${titleA}"`);

    log('CDP', '用户B 的浏览器打开 example.com...');
    const { sessionId: sessB } = await createPageAndNavigate(clientB, 'https://example.com');
    const titleB = (await clientB.send('Runtime.evaluate', { expression: 'document.title' }, sessB))?.result?.value;
    log('CDP', `用户B example.com title: "${titleB}"`);

    // Step 7: 验证隔离
    const tgA = await clientA.send('Target.getTargets');
    const tgB = await clientB.send('Target.getTargets');
    const urlsA = (tgA.targetInfos || []).filter(t => t.type === 'page').map(t => t.url);
    const urlsB = (tgB.targetInfos || []).filter(t => t.type === 'page').map(t => t.url);
    log('VERIFY', `用户A 看到的页面: ${JSON.stringify(urlsA)}`);
    log('VERIFY', `用户B 看到的页面: ${JSON.stringify(urlsB)}`);

    console.log('\n=== 结果 ===');
    console.log(`  用户A 打开百度:    ${titleA === '百度一下，你就知道' ? '✅' : '❌'} (${titleA})`);
    console.log(`  用户B 打开 example: ${titleB === 'Example Domain' ? '✅' : '❌'} (${titleB})`);
    console.log(`  A 看不到 B 的页面:  ${!urlsA.some(u => u.includes('example.com')) ? '✅' : '❌'}`);
    console.log(`  B 看不到 A 的页面:  ${!urlsB.some(u => u.includes('baidu')) ? '✅' : '❌'}`);
    console.log('');

  } finally {
    // 清理
    try { if (clientA) clientA.close(); } catch {}
    try { if (clientB) clientB.close(); } catch {}
    try { if (chromeA) killChrome(chromeA); } catch {}
    try { if (chromeB) killChrome(chromeB); } catch {}
    try { proxyProc && proxyProc.kill('SIGTERM'); } catch {}
  }
})();
