#!/usr/bin/env node
'use strict';

/**
 * A/B Gate 测试：直连 Chrome CDP vs cdp-tunnel 端口池
 *
 * 这个测试是提交前必须通过的 gate。
 * 同一个 Chromium 实例，同一套操作，断言两边结果一致。
 *
 * 用法：node tests/e2e/test-ab-gate.js
 * 退出码 0 = 通过，1 = 失败
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

const DIRECT_PORT = 29700;
const PLUGIN_PORT = 29701;
const POOL_PORT = 29702;
const TAKEOVER_PORT = 29703;
const WEB_PORT = 29720;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

// CDP 客户端：resolve(msg.result)，不是整个 msg
function makeClient(ws) {
  const pending = new Map();
  let id = 1;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
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
  return { cdp };
}

function makePoolClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const c = makeClient(ws);
  c.open = new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  c.ws = ws;
  return c;
}

async function connectRdp(port) {
  const ver = await httpGet(port, '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  const c = makeClient(ws);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  c.ws = ws;
  return c;
}

const TEST_HTML = '<!DOCTYPE html><html><body>' +
  '<input id="i"><button id="b" onclick="document.getElementById(\'r\').textContent=\'clicked\'">Btn</button>' +
  '<div id="r">none</div>' +
  '<script>console.log("page loaded")</script></body></html>';

let proxyProc, directChrome, webServer, configOriginal;
let passed = 0, failed = 0;
const mismatches = [];

function record(label, aVal, bVal) {
  const match = JSON.stringify(aVal) === JSON.stringify(bVal);
  if (match) { passed++; console.log(`  ✅ ${label}`); }
  else {
    failed++; mismatches.push(label);
    console.log(`  ❌ ${label}`);
    console.log(`     直连: ${JSON.stringify(aVal)?.slice(0, 80)}`);
    console.log(`     端口池: ${JSON.stringify(bVal)?.slice(0, 80)}`);
  }
}

async function runSequence(cdp) {
  const r = {};

  // createTarget
  const ct = await cdp('Target.createTarget', { url: `http://localhost:${WEB_PORT}/` });
  r.hasTarget = !!ct.targetId;

  // attach
  const at = await cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
  r.hasSession = !!at.sessionId;
  const sid = at.sessionId;

  await cdp('Page.enable', {}, sid);
  await cdp('Runtime.enable', {}, sid);
  await cdp('Network.enable', {}, sid);
  await sleep(2000);

  // evaluate
  const ev = await cdp('Runtime.evaluate', { expression: 'document.getElementById("r").textContent', returnByValue: true }, sid);
  r.evalResult = ev.result.value;

  // insertText
  await cdp('Runtime.evaluate', { expression: 'document.getElementById("i").focus()' }, sid);
  await cdp('Input.insertText', { text: 'hello' }, sid);
  await sleep(300);
  const inputVal = await cdp('Runtime.evaluate', { expression: 'document.getElementById("i").value', returnByValue: true }, sid);
  r.inputValue = inputVal.result.value;

  // dispatchKey
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, text: '!' }, sid);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49 }, sid);
  await sleep(300);
  const keyVal = await cdp('Runtime.evaluate', { expression: 'document.getElementById("i").value', returnByValue: true }, sid);
  r.keyValue = keyVal.result.value;

  // mouse click
  const coords = JSON.parse((await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({x:Math.round(document.getElementById("b").getBoundingClientRect().x+20),y:Math.round(document.getElementById("b").getBoundingClientRect().y+10)})',
    returnByValue: true
  }, sid)).result.value);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
  await sleep(500);
  const clickResult = await cdp('Runtime.evaluate', { expression: 'document.getElementById("r").textContent', returnByValue: true }, sid);
  r.clickResult = clickResult.result.value;

  // screenshot
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sid);
  r.hasScreenshot = !!shot.data;

  // cookie
  await cdp('Network.setCookie', { name: 'test', value: 'ok', url: `http://localhost:${WEB_PORT}/` }, sid);
  const cookies = await cdp('Network.getCookies', { urls: [`http://localhost:${WEB_PORT}/`] }, sid);
  r.cookieCount = cookies.cookies.length;

  // localStorage
  const ls = await cdp('Runtime.evaluate', { expression: '(localStorage.setItem("k","v"),localStorage.getItem("k"))', returnByValue: true }, sid);
  r.localStorage = ls.result.value;

  // getTargets
  const tg = await cdp('Target.getTargets');
  r.targetCount = (tg.targetInfos || []).filter(t => t.type === 'page').length;

  // /json/list (HTTP)
  r.jsonListCount = await new Promise(resolve => {
    // 直连用 DIRECT_PORT，端口池用 POOL_PORT——但这里不知道是哪个
    // 返回 -1 表示不测（直连 Chrome 的 /json/list 返回所有 tab）
    resolve(-1);
  });

  await cdp('Target.closeTarget', { targetId: ct.targetId }).catch(() => {});

  return r;
}

(async () => {
  console.log(`\n=== A/B Gate: 直连 Chrome vs 端口池 ===\n`);

  try {
    webServer = http.createServer((req, res) => {
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
        POOL_START: String(POOL_PORT), POOL_SIZE: '1', POOL_TAKEOVER_PORT: String(TAKEOVER_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    for (let i = 0; i < 20; i++) { try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); } }

    const profile = `/tmp/cdp-gate-${Date.now()}`;
    directChrome = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      `--remote-debugging-port=${DIRECT_PORT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=DialMediaRouteProvider', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    directChrome._profile = profile;
    await sleep(4000);

    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try { const v = await httpGet(PLUGIN_PORT, '/json/version'); if (v && v.webSocketDebuggerUrl) { extReady = true; break; } } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Ready\n');

    // A: 直连
    console.log('▼ A: 直连 Chrome');
    const directConn = await connectRdp(DIRECT_PORT);
    const resultA = await runSequence(directConn.cdp);
    directConn.ws.close();
    await sleep(1000);

    // B: 端口池
    console.log('\n▼ B: 端口池');
    const poolClient = makePoolClient(POOL_PORT);
    await poolClient.open;
    const resultB = await runSequence(poolClient.cdp);
    poolClient.ws.close();

    // 对比
    console.log('\n▼ 对比\n');
    record('createTarget', resultA.hasTarget, resultB.hasTarget);
    record('attachToTarget', resultA.hasSession, resultB.hasSession);
    record('evaluate', resultA.evalResult, resultB.evalResult);
    record('insertText', resultA.inputValue, resultB.inputValue);
    record('dispatchKeyEvent', resultA.keyValue, resultB.keyValue);
    record('mouse click', resultA.clickResult, resultB.clickResult);
    record('screenshot', resultA.hasScreenshot, resultB.hasScreenshot);
    record('cookie', resultA.cookieCount > 0, resultB.cookieCount > 0);
    record('localStorage', resultA.localStorage, resultB.localStorage);
    record('getTargets', resultA.targetCount > 0, resultB.targetCount > 0);

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    failed++;
  } finally {
    if (webServer) webServer.close();
    if (directChrome) { try { process.kill(-directChrome.pid); } catch {} try { fs.rmSync(directChrome._profile, { recursive: true, force: true }); } catch {} }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (mismatches.length > 0) {
    console.log('不一致: ' + mismatches.join(', '));
  }
  process.exit(failed > 0 ? 1 : 0);
})();
