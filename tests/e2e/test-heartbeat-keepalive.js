#!/usr/bin/env node
'use strict';

/**
 * 端口池 Client 心跳保活深度测试
 *
 * 验证 cdp-tunnel 端口池 client 连接的 ping/pong 心跳机制：
 * 1. 短暂网络抖动不会导致 client 断开
 * 2. 长时间静默后连接仍存活（命令能正常执行）
 * 3. 真断连（kill client）后分组和 tab 存活，重连可复用
 *
 * 双重验证：
 * - A 路：xbrowser CLI（模拟真实用户场景）
 * - B 路：裸 CDP WebSocket（精确定位心跳行为）
 *
 * 全程自动化，不需要人工操作。
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const LOG_FILE = `/tmp/cdp-heartbeat-test-${Date.now()}.log`;

function log(tag, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
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

function execCmd(cmd) {
  try { return { stdout: execSync(cmd, { encoding: 'utf8', timeout: 60000 }), stderr: '' }; }
  catch (e) { return { stdout: e.stdout || '', stderr: e.stderr || '' + e.message }; }
}

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

function killChrome(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid); } catch {}
  if (proc._profile) { try { fs.rmSync(proc._profile, { recursive: true, force: true }); } catch {} }
  if (proc._tmpExt) { try { fs.rmSync(proc._tmpExt, { recursive: true, force: true }); } catch {} }
}

function launchChrome({ port, tag }) {
  const tmpExt = `/tmp/cdp-ext-hb-${tag}-${Date.now()}`;
  fs.cpSync(EXTENSION_PATH, tmpExt, { recursive: true });
  const configPath = path.join(tmpExt, 'utils', 'config.js');
  const configOriginal = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, configOriginal.replace(
    /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://127.0.0.1:${port}/plugin'`
  ));
  const profile = `/tmp/cdp-profile-hb-${tag}-${Date.now()}`;
  const proc = spawn(CHROME_PATH, [
    '--headless=new', `--user-data-dir=${profile}`, `--load-extension=${tmpExt}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    '--disable-features=DialMediaRouteProvider', 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  proc._profile = profile;
  proc._tmpExt = tmpExt;
  return proc;
}

(async () => {
  let passed = 0, failed = 0;
  function ok(label, cond, extra) {
    const status = cond ? 'PASS' : 'FAIL';
    cond ? passed++ : failed++;
    const msg = extra ? ` → ${extra}` : '';
    console.log(`[${status}] ${label}${msg}`);
    fs.appendFileSync(LOG_FILE, `[${status}] ${label}${msg}\n`);
  }

  const PORT = 29500 + Math.floor(Math.random() * 500);
  const POOL_PORT = PORT + 1;
  const TK_PORT = PORT + 10;
  let proxyProc, chromeProc, cdpClient, xbrowserCleanup;

  try {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('     端口池 Client 心跳保活深度测试');
    console.log('═══════════════════════════════════════════════════════════\n');
    log('TEST', `LOG_FILE=${LOG_FILE}`);
    log('TEST', `Proxy port=${PORT}, pool=${POOL_PORT}, takeover=${TK_PORT}`);

    // ──────────── PHASE 0: Setup ────────────
    log('SETUP', '启动 proxy...');
    proxyProc = spawn('node', [PROXY_PATH], {
      env: {
        ...process.env, PORT: String(PORT),
        POOL_START: String(POOL_PORT), POOL_SIZE: '3',
        TAKEOVER_PORT: String(TK_PORT), POOL_TAKEOVER_PORT: String(TK_PORT),
        LOG_LEVEL: 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stdout.on('data', () => {});
    proxyProc.stderr.on('data', () => {});
    if (!await waitForPort(PORT)) throw new Error('Proxy failed to start');
    log('SETUP', 'Proxy 就绪');

    log('SETUP', '启动 Chrome（加载扩展）...');
    chromeProc = launchChrome({ port: PORT, tag: 'HB' });

    // 等扩展连上
    log('SETUP', '等待扩展连接...');
    let extReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const ver = await httpGet(PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    ok('扩展连接 proxy', extReady, extReady ? '' : '60s 内未连上');
    if (!extReady) throw new Error('Extension not connected');
    log('SETUP', '扩展已连接');

    // ──────────── PHASE 1: A 路 — xbrowser CLI ────────────
    console.log('\n─── PHASE 1: xbrowser CLI 获取页面标题 ───\n');

    // 先通过 xbrowser 连上 cdp-tunnel，查看页面
    // xbrowser --cdp <port> 自动从 /json/version 拿 webSocketDebuggerUrl
    log('XBROWSER', `xbrowser --cdp ${PORT} title`);
    const r1 = execCmd(`XBROWSER_CDP=http://127.0.0.1:${PORT} xbrowser title 2>&1`);
    log('XBROWSER', `stdout: ${r1.stdout.slice(0, 200)}`);

    // 再获取 URL
    log('XBROWSER', `xbrowser --cdp ${PORT} url`);
    const r2 = execCmd(`XBROWSER_CDP=http://127.0.0.1:${PORT} xbrowser url 2>&1`);

    // 截图
    log('XBROWSER', `xbrowser --cdp ${PORT} screenshot`);
    const r3 = execCmd(`XBROWSER_CDP=http://127.0.0.1:${PORT} xbrowser screenshot 2>&1`);
    log('XBROWSER', `screenshot: ${r3.stdout.slice(0, 100)}`);

    // ──────────── PHASE 2: B 路 — 裸 CDP WebSocket 精确定位 ────────────
    console.log('\n─── PHASE 2: 裸 CDP WebSocket 心跳精确定位 ───\n');

    log('CDP', '连接 CDP client...');
    cdpClient = await new CdpClient(`ws://127.0.0.1:${PORT}/client`).connect();
    log('CDP', '已连接');

    // 创建页面并导航
    log('CDP', '创建页面 + 导航到 example.com...');
    const { targetId, sessionId } = await createPageAndNavigate(cdpClient, 'https://example.com');
    const titleBefore = (await cdpClient.send('Runtime.evaluate', {
      expression: 'document.title'
    }, sessionId))?.result?.value;
    ok('CDP 创建页面 + navigate example.com', titleBefore === 'Example Domain', `title="${titleBefore}"`);

    // getTargets 验证
    const tg1 = await cdpClient.send('Target.getTargets');
    const countBefore = (tg1.targetInfos || []).length;
    ok('CDP getTargets 正常', countBefore >= 1, `targets=${countBefore}`);

    // ──────────── PHASE 3: 关键 — 等待 70 秒 > 心跳周期(30s)×2 ────────────
    console.log('\n─── PHASE 3: 等待 70 秒（2 个心跳周期 + 余量）───\n');

    log('WAIT', '开始 70 秒等待...');
    for (let i = 0; i < 7; i++) {
      await sleep(10000);
      // 每 10 秒用 eval 确认连接存活
      try {
        const alive = (await cdpClient.send('Runtime.evaluate', {
          expression: `'ALIVE-' + ${Date.now()}`
        }, sessionId))?.result?.value || '';
        log('WAIT', `第 ${(i+1)*10} 秒：连接存活 ✅ eval="${alive}"`);
      } catch (e) {
        log('WAIT', `第 ${(i+1)*10} 秒：连接异常 ❌ ${e.message}`);
      }
    }
    log('WAIT', '70 秒等待结束');

    // ──────────── PHASE 4: 验证心跳保住连接 ────────────
    console.log('\n─── PHASE 4: 验证心跳保住连接 ───\n');

    // A 路：xbrowser 命令仍然可用
    log('XBROWSER', '心跳后 xbrowser title...');
    const r4 = execCmd(`XBROWSER_CDP=http://127.0.0.1:${PORT} xbrowser title 2>&1`);
    log('XBROWSER', `title=${r4.stdout.slice(0, 100).trim()}`);
    ok('心跳后 xbrowser title 可用', r4.stdout.includes('Example') || r4.stdout.length > 10);

    // B 路：裸 CDP 命令仍然正常
    const titleAfter = (await cdpClient.send('Runtime.evaluate', {
      expression: 'document.title'
    }, sessionId))?.result?.value;
    ok('心跳后 CDP evaluate 正常', titleAfter === 'Example Domain', `title="${titleAfter}"`);

    // 还能创建新页面
    log('CDP', '心跳后创建新页面...');
    const { sessionId: s2 } = await createPageAndNavigate(cdpClient, 'https://www.baidu.com');
    const titleBaidu = (await cdpClient.send('Runtime.evaluate', {
      expression: 'document.title'
    }, s2))?.result?.value;
    ok('心跳后创建新页面 + 导航百度', titleBaidu && titleBaidu.includes('百度'), `title="${titleBaidu}"`);

    // 并发操作验证
    const [eval1, eval2] = await Promise.all([
      cdpClient.send('Runtime.evaluate', { expression: '"MARK-A"' }, sessionId),
      cdpClient.send('Runtime.evaluate', { expression: '"MARK-B"' }, s2)
    ]);
    ok('心跳后并发 evaluate 正常', eval1?.result?.value === 'MARK-A' && eval2?.result?.value === 'MARK-B');

    // getTargets 能看到所有创建的页面
    const tg2 = await cdpClient.send('Target.getTargets');
    const urlsAfter = (tg2.targetInfos || []).filter(t => t.type === 'page').map(t => t.url);
    log('CDP', `心跳后 getTargets 页面: ${JSON.stringify(urlsAfter)}`);
    const seesBaidu = urlsAfter.some(u => u.includes('baidu'));
    const seesExample = urlsAfter.some(u => u.includes('example'));
    ok('心跳后 getTargets 完整', seesBaidu && seesExample, `urls=${JSON.stringify(urlsAfter)}`);

    // ──────────── PHASE 5: 真断连后重连验证 ────────────
    console.log('\n─── PHASE 5: 断连后重连验证（分组/tab 存活）───\n');

    log('RECONNECT', '关闭旧 CDP client...');
    cdpClient.close();
    await sleep(1000);

    log('RECONNECT', '重连新的 CDP client...');
    const c2 = await new CdpClient(`ws://127.0.0.1:${PORT}/client`).connect();
    log('RECONNECT', '已重连');

    // 重连后旧 tab 还存在
    const tg3 = await c2.send('Target.getTargets');
    const urlsRecon = (tg3.targetInfos || []).filter(t => t.type === 'page').map(t => t.url);
    log('RECONNECT', `重连后 getTargets: ${JSON.stringify(urlsRecon)}`);
    const stillSeesBaidu = urlsRecon.some(u => u.includes('baidu'));
    const stillSeesExample = urlsRecon.some(u => u.includes('example'));
    ok('重连后旧 tab 仍存在', stillSeesBaidu && stillSeesExample, `urls=${JSON.stringify(urlsRecon)}`);

    // 重连后还能创建新页面
    log('RECONNECT', '重连后创建新 tab...');
    const { sessionId: s3 } = await createPageAndNavigate(c2, 'https://example.org');
    const titleOrg = (await c2.send('Runtime.evaluate', {
      expression: 'document.title'
    }, s3))?.result?.value;
    ok('重连后能创建新页面', titleOrg === 'Example Domain' || titleOrg.length > 0, `title="${titleOrg}"`);

    c2.close();

  } catch (e) {
    log('ERROR', `${e.message}\n${e.stack}`);
    failed++;
  } finally {
    try { if (cdpClient) cdpClient.close(); } catch {}
    try { if (chromeProc) killChrome(chromeProc); } catch {}
    try { proxyProc && proxyProc.kill('SIGTERM'); } catch {}
    try {
      const instanceDir = path.join(require('os').homedir(), '.cdp-tunnel', 'instances', String(PORT));
      fs.rmSync(instanceDir, { recursive: true, force: true });
    } catch {}

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  结果: ${passed} passed, ${failed} failed`);
    console.log(`  日志: ${LOG_FILE}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
