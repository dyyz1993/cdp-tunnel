#!/usr/bin/env node
'use strict';

/**
 * 专门验证 Issue #1 (title 为空) 和 Issue #2 (elementScreenshot missing) 的修复
 *
 * Issue #1: goto 成功后 Target.getTargetInfo 返回的 title 不为空
 * Issue #2: 带 clip 的 Page.captureScreenshot 在 extension 模式下能返回数据
 *
 * 全自动环境：自己起 proxy + Chromium + 加载扩展，不依赖用户操作
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PLUGIN_PORT = 29801;
const POOL_PORT = 29802;
const TAKEOVER_PORT = 29803;
const WEB_PORT = 29820;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function makeClient(ws) {
  const pending = new Map();
  const eventListeners = [];
  let id = 1;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      eventListeners.forEach(fn => fn(msg));
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('Timeout: ' + method)); } }, 20000);
      const o = { id: i, method, params };
      if (sessionId) o.sessionId = sessionId;
      ws.send(JSON.stringify(o));
    });
  }
  return { cdp, onEvent: (fn) => eventListeners.push(fn) };
}

function makePoolClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const c = makeClient(ws);
  c.open = new Promise((r, e) => {
    ws.on('open', () => { console.log('[CLIENT] WebSocket opened'); r(); });
    ws.on('error', (err) => { console.log('[CLIENT] WebSocket error:', err.message); e(err); });
    ws.on('close', (code, reason) => { console.log(`[CLIENT] WebSocket closed: code=${code} reason=${reason.toString()}`); });
  });
  c.ws = ws;
  return c;
}

const TEST_HTML = '<!DOCTYPE html><html><head><title>IssueTestPage</title></head><body>' +
  '<input id="i" type="text">' +
  '<button id="b" onclick="document.getElementById(\'r\').textContent=\'clicked\'">Btn</button>' +
  '<div id="r">none</div>' +
  '<div id="big" style="width:200px;height:100px;background:blue"></div>' +
  '</body></html>';

let proxyProc, chromeProc, webServer, configOriginal;
let passed = 0, failed = 0;

function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}` + (detail ? ` — ${detail}` : '')); }
}

(async () => {
  console.log(`\n=== Issue Fix Verification ===\n`);

  try {
    // 1. 起 web server
    webServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    await new Promise(r => webServer.listen(WEB_PORT, r));

    // 2. 改 config.js
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    // 3. 起 proxy
    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PLUGIN_PORT), TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(POOL_PORT), POOL_SIZE: '1', POOL_TAKEOVER_PORT: String(TAKEOVER_PORT), LOG_LEVEL: 'info' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.log(`[PROXY] ${s.substring(0, 200)}`);
    });
    proxyProc.stdout.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.log(`[PROXY-OUT] ${s.substring(0, 200)}`);
    });
    for (let i = 0; i < 20; i++) { try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); } }

    // 4. 起 Chromium + 加载扩展
    const profile = `/tmp/cdp-issue-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;

    // 5. 等扩展连接（检查 /json/version 的 webSocketDebuggerUrl）
    await sleep(8000); // 先等 Chromium 启动
    let extReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const v = await httpGet(PLUGIN_PORT, '/json/version');
        if (v && v.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    await sleep(2000);
    console.log('Extension connected\n');

    // 6. 连接端口池（带重试，防止扩展还没完全就绪）
    let client;
    for (let attempt = 0; attempt < 5; attempt++) {
      client = makePoolClient(POOL_PORT);
      await client.open;
      await sleep(1000);
      // 检查 ws 是否还开着
      if (client.ws.readyState === WebSocket.OPEN) {
        // 试发一个简单命令
        try {
          await client.cdp('Target.getTargets');
          break;
        } catch (e) {
          console.log(`[CLIENT] attempt ${attempt + 1} failed: ${e.message}, retrying...`);
          client.ws.close();
          await sleep(3000);
        }
      } else {
        console.log(`[CLIENT] attempt ${attempt + 1}: ws closed, retrying...`);
        await sleep(3000);
      }
    }

    // 监听 targetInfoChanged 事件
    const targetInfoChangedEvents = [];
    client.onEvent((msg) => {
      if (msg.method === 'Target.targetInfoChanged') {
        targetInfoChangedEvents.push(msg.params);
      }
    });

    // === Issue #1 测试：goto 后 title 不为空 ===
    console.log('▼ Issue #1: title after navigate');

    // createTarget
    const ct = await client.cdp('Target.createTarget', { url: `http://localhost:${WEB_PORT}/` });
    const targetId = ct.targetId;
    assert('createTarget succeeded', !!targetId);

    // attach
    const at = await client.cdp('Target.attachToTarget', { targetId, flatten: true });
    const sid = at.sessionId;
    assert('attachToTarget succeeded', !!sid);

    // enable Page + Runtime
    await client.cdp('Page.enable', {}, sid);
    await client.cdp('Runtime.enable', {}, sid);

    // 等页面加载完成
    await sleep(3000);

    // Target.getTargetInfo — title 不应为空
    const info = await client.cdp('Target.getTargetInfo', { targetId });
    const title = info && info.targetInfo ? info.targetInfo.title : '';
    assert('Target.getTargetInfo title not empty', !!title && title.length > 0, `title="${title}"`);
    assert('Target.getTargetInfo title matches', title === 'IssueTestPage', `title="${title}"`);

    // Target.getTargets — title 也不应为空
    const tg = await client.cdp('Target.getTargets');
    const pageTargets = (tg.targetInfos || []).filter(t => t.type === 'page');
    const ourTarget = pageTargets.find(t => t.targetId === targetId);
    if (ourTarget) {
      assert('Target.getTargets title not empty', !!ourTarget.title && ourTarget.title.length > 0, `title="${ourTarget.title}"`);
    } else {
      assert('Target.getTargets found our target', false);
    }

    // 等一下 targetInfoChanged 事件
    await sleep(2000);
    const titleChangedEvent = targetInfoChangedEvents.find(e =>
      e.targetInfo && e.targetInfo.targetId === targetId && e.targetInfo.title
    );
    assert('Target.targetInfoChanged event received with title', !!titleChangedEvent,
      targetInfoChangedEvents.length > 0
        ? `got ${targetInfoChangedEvents.length} events, title in event: ${titleChangedEvent ? titleChangedEvent.targetInfo.title : 'N/A'}`
        : 'no targetInfoChanged events received');

    // === Issue #2 测试：带 clip 的 Page.captureScreenshot ===
    console.log('\n▼ Issue #2: elementScreenshot (clip)');

    // 全页截图（不带 clip）— baseline
    const fullShot = await client.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sid);
    assert('full screenshot has data', !!fullShot.data && fullShot.data.length > 0);

    // 元素截图（带 clip）— 这是 issue #2 的核心
    const clip = { x: 0, y: 0, width: 200, height: 100, scale: 1 };
    const elementShot = await client.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30, clip }, sid);
    assert('element screenshot (clip) has data', !!elementShot.data && elementShot.data.length > 0,
      elementShot.data ? `data length=${elementShot.data.length}` : 'no data');

    // 清理
    await client.cdp('Target.closeTarget', { targetId }).catch(() => {});
    client.ws.close();

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    console.log(e.stack);
    failed++;
  } finally {
    if (webServer) webServer.close();
    if (chromeProc) { try { process.kill(-chromeProc.pid); } catch {} try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {} }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
