#!/usr/bin/env node
'use strict';

/**
 * 全面对比测试：直连 Chrome CDP vs cdp-tunnel 端口池
 *
 * 覆盖所有常用 CDP domain：
 * - Target: createTarget/attach/closeTarget
 * - Page: navigate/captureScreenshot/startScreencast
 * - Runtime: evaluate/addScriptToEvaluateOnNewDocument/consoleAPICalled
 * - Input: insertText/dispatchKeyEvent/dispatchMouseEvent
 * - Network: enable/requestWillBeSent 事件
 * - DOM: getDocument/querySelector
 * - Emulation: setDeviceMetricsOverride
 *
 * 同一个 Chromium，同一个页面，同一套操作。
 * 断言两边结果一致。
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

const DIRECT_PORT = 29500;
const PLUGIN_PORT = 29501;
const POOL_PORT = 29502;
const TAKEOVER_PORT = 29503;        // 主 takeover
const POOL_TAKEOVER_PORT = 29500;   // 端口池 takeover（和 DIRECT_PORT 不同）
const WEB_PORT = 29520;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

// 带事件收集的 CDP 客户端
function makeCdpClient(ws) {
  const pending = new Map();
  const events = [];
  let id = 1;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
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

  return { cdp, events, ws, clearEvents: () => events.length = 0 };
}

function makePoolClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const client = makeCdpClient(ws);
  client.open = new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  return client;
}

async function connectRdp(port) {
  const ver = await httpGet(port, '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  const client = makeCdpClient(ws);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  return client;
}

// 测试页面（带 console.log、网络请求、动画）
const TEST_HTML = `<!DOCTYPE html><html><body>
<input id="testInput">
<button id="testBtn" onclick="fetch('/api').then(r=>r.text()).then(t=>document.getElementById('result').textContent=t)">Fetch</button>
<div id="result">none</div>
<div id="counter">0</div>
<script>
console.log('page loaded');
console.warn('test warning');
window.__keys=[];
document.getElementById('testInput').addEventListener('keydown',function(e){window.__keys.push(e.key)});
setInterval(function(){var c=document.getElementById('counter');c.textContent=parseInt(c.textContent)+1},500);
</script>
</body></html>`;

let proxyProc, chromeProc, webServer, configOriginal;
let passed = 0, failed = 0;
const mismatches = [];

function record(label, aVal, bVal) {
  const match = JSON.stringify(aVal) === JSON.stringify(bVal);
  if (match) { passed++; console.log(`  ✅ ${label}`); }
  else {
    failed++; mismatches.push({ label, aVal, bVal });
    console.log(`  ❌ ${label}`);
    console.log(`     直连: ${JSON.stringify(aVal).slice(0, 100)}`);
    console.log(`     端口池: ${JSON.stringify(bVal).slice(0, 100)}`);
  }
}

function recordBool(label, aVal, bVal) {
  record(label, !!aVal, !!bVal);
}

async function runFullSequence(cdp, createTarget) {
  const r = {};

  // === Target ===
  const ct = await createTarget();
  r.hasTarget = !!ct.targetId;

  const at = await cdp.cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
  r.hasSession = !!at.sessionId;
  const sid = at.sessionId;

  await cdp.cdp('Page.enable', {}, sid);
  await cdp.cdp('Runtime.enable', {}, sid);
  await cdp.cdp('Network.enable', {}, sid);
  cdp.clearEvents();

  // === Page.navigate ===
  const nav = await cdp.cdp('Page.navigate', { url: `http://localhost:${WEB_PORT}/` }, sid);
  r.navError = nav.errorText || 'OK';
  await sleep(2000);

  // === Runtime.evaluate ===
  const ev1 = await cdp.cdp('Runtime.evaluate', { expression: 'document.querySelector("#result").textContent', returnByValue: true }, sid);
  r.initialResult = ev1.result.value;

  // === Runtime.consoleAPICalled（console.log 事件）===
  const consoleEvents = cdp.events.filter(e => e.method === 'Runtime.consoleAPICalled');
  r.consoleLogCount = consoleEvents.length;
  r.consoleLogMsg = consoleEvents.length > 0
    ? (consoleEvents[0].params.args[0]?.value || consoleEvents[0].params.args[0]?.description || '')
    : '';

  // === addScriptToEvaluateOnNewDocument（注入脚本）===
  const injectRes = await cdp.cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__injected=true;' }, sid);
  r.injectScriptId = !!injectRes.identifier;

  // 重新 navigate 触发注入脚本
  await cdp.cdp('Page.navigate', { url: `http://localhost:${WEB_PORT}/` }, sid);
  await sleep(1500);
  const injectCheck = await cdp.cdp('Runtime.evaluate', { expression: 'window.__injected', returnByValue: true }, sid);
  r.injectWorked = injectCheck.result.value === true;

  // === Input.insertText ===
  await cdp.cdp('Runtime.evaluate', { expression: 'document.getElementById("testInput").focus()' }, sid);
  await cdp.cdp('Input.insertText', { text: 'hello' }, sid);
  await sleep(300);
  const inputVal = await cdp.cdp('Runtime.evaluate', { expression: 'document.getElementById("testInput").value', returnByValue: true }, sid);
  r.insertTextResult = inputVal.result.value;

  // === Input.dispatchKeyEvent ===
  await cdp.cdp('Runtime.evaluate', { expression: 'document.getElementById("testInput").focus()' }, sid);
  await cdp.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, text: '!' }, sid);
  await cdp.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49 }, sid);
  await sleep(300);
  const keyVal = await cdp.cdp('Runtime.evaluate', { expression: 'document.getElementById("testInput").value', returnByValue: true }, sid);
  r.keyEventResult = keyVal.result.value;

  // === Input.dispatchMouseEvent (click button → fetch) ===
  const coords = JSON.parse((await cdp.cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({x:Math.round(document.getElementById("testBtn").getBoundingClientRect().x+30),y:Math.round(document.getElementById("testBtn").getBoundingClientRect().y+10)})',
    returnByValue: true
  }, sid)).result.value);
  cdp.clearEvents();
  await cdp.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
  await cdp.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
  await sleep(1000);
  const clickResult = await cdp.cdp('Runtime.evaluate', { expression: 'document.getElementById("result").textContent', returnByValue: true }, sid);
  r.clickFetchResult = clickResult.result.value;

  // === Network 事件 ===
  const netEvents = cdp.events.filter(e => e.method === 'Network.requestWillBeSent');
  r.networkRequestCount = netEvents.length;
  r.hasFetchRequest = netEvents.some(e => e.params.request && e.params.request.url.includes('/api'));

  // === DOM.getDocument + querySelector ===
  const doc = await cdp.cdp('DOM.getDocument', { depth: 1 }, sid);
  r.hasDomRoot = !!doc.root;
  const qsa = await cdp.cdp('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '#testInput' }, sid);
  r.domInputCount = qsa.nodeIds ? qsa.nodeIds.length : 0;

  // === Emulation.setDeviceMetricsOverride ===
  try {
    await cdp.cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }, sid);
    const dim = await cdp.cdp('Runtime.evaluate', { expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})', returnByValue: true }, sid);
    r.emulatedDims = JSON.parse(dim.result.value);
  } catch (e) {
    r.emulatedDims = { error: e.message };
  }

  // === Page.captureScreenshot ===
  const shot = await cdp.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sid);
  r.screenshotLen = shot.data ? shot.data.length : 0;

  // === Page.startScreencast（收 1 帧后停止）===
  cdp.clearEvents();
  await cdp.cdp('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 200, maxHeight: 200, everyNthFrame: 1 }, sid);
  await sleep(2000);
  await cdp.cdp('Page.stopScreencast', {}, sid);
  const screencastFrames = cdp.events.filter(e => e.method === 'Page.screencastFrame');
  r.screencastFrameCount = screencastFrames.length;

  // 清理
  await cdp.cdp('Target.closeTarget', { targetId: ct.targetId }).catch(() => {});

  return r;
}

(async () => {
  console.log(`\n=== 全面 A/B 对比: 直连 Chrome CDP vs cdp-tunnel 端口池 ===\n`);

  try {
    webServer = http.createServer((req, res) => {
      if (req.url.startsWith('/api')) { res.writeHead(200); res.end('api-response-' + Date.now()); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    await new Promise(r => webServer.listen(WEB_PORT, r));

    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PLUGIN_PORT), TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(POOL_PORT), POOL_SIZE: '1', POOL_TAKEOVER_PORT: String(POOL_TAKEOVER_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    for (let i = 0; i < 20; i++) { try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); } }

    const profile = `/tmp/cdp-ab-full-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      `--remote-debugging-port=${DIRECT_PORT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=DialMediaRouteProvider', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    await sleep(4000);

    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try { const v = await httpGet(PLUGIN_PORT, '/json/version'); if (v && v.webSocketDebuggerUrl) { extReady = true; break; } } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Ready\n');

    // === A: 直连 ===
    console.log('▼ A: 直连 Chrome CDP');
    const directConn = await connectRdp(DIRECT_PORT);
    const resultA = await runFullSequence(directConn, () =>
      directConn.cdp('Target.createTarget', { url: 'about:blank' })
    );
    directConn.ws.close();
    await sleep(1000);

    // === B: 端口池 ===
    console.log('\n▼ B: cdp-tunnel 端口池');
    const poolClient = makePoolClient(POOL_PORT);
    await poolClient.open;
    const resultB = await runFullSequence(poolClient, () =>
      poolClient.cdp('Target.createTarget', { url: 'about:blank' })
    );
    poolClient.ws.close();

    // === 对比 ===
    console.log('\n▼ 对比\n');
    recordBool('Target.createTarget', resultA.hasTarget, resultB.hasTarget);
    recordBool('Target.attachToTarget', resultA.hasSession, resultB.hasSession);
    record('Page.navigate', resultA.navError, resultB.navError);
    record('Runtime.evaluate 初始', resultA.initialResult, resultB.initialResult);

    console.log('\n  --- Console ---');
    recordBool('console.log 事件收到', resultA.consoleLogCount > 0, resultB.consoleLogCount > 0);
    record('console.log 内容', resultA.consoleLogMsg, resultB.consoleLogMsg);

    console.log('\n  --- 注入脚本 ---');
    recordBool('addScriptToEvaluateOnNewDocument', resultA.injectScriptId, resultB.injectScriptId);
    recordBool('注入脚本生效', resultA.injectWorked, resultB.injectWorked);

    console.log('\n  --- Input ---');
    record('insertText', resultA.insertTextResult, resultB.insertTextResult);
    record('dispatchKeyEvent', resultA.keyEventResult, resultB.keyEventResult);
    record('mouse click → fetch', resultA.clickFetchResult.startsWith('api-response'), resultB.clickFetchResult.startsWith('api-response'));

    console.log('\n  --- Network ---');
    recordBool('Network.requestWillBeSent 收到', resultA.networkRequestCount > 0, resultB.networkRequestCount > 0);
    recordBool('fetch /api 请求捕获', resultA.hasFetchRequest, resultB.hasFetchRequest);

    console.log('\n  --- DOM ---');
    recordBool('DOM.getDocument', resultA.hasDomRoot, resultB.hasDomRoot);
    record('querySelectorAll(#testInput)', resultA.domInputCount, resultB.domInputCount);

    console.log('\n  --- Emulation ---');
    record('setDeviceMetricsOverride', resultA.emulatedDims.w, resultB.emulatedDims.w);

    console.log('\n  --- 截图 ---');
    recordBool('captureScreenshot 有数据', resultA.screenshotLen > 0, resultB.screenshotLen > 0);
    recordBool('startScreencast 收到帧', resultA.screencastFrameCount > 0, resultB.screencastFrameCount > 0);

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
  if (mismatches.length > 0) {
    console.log('\n不一致项:');
    mismatches.forEach(m => console.log(`  - ${m.label}`));
  }
  process.exit(failed > 0 ? 1 : 0);
})();
