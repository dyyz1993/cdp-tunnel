#!/usr/bin/env node
'use strict';

/**
 * 有头 Chromium 验证端口池 v3.0.7
 * 连真实 proxy 的端口池端口（9231），测 dispatchKeyEvent/screencast/Network
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const POOL_PORT = 9231;
const WEB_PORT = 29700;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function makeClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const pending = new Map();
  let id = 1;
  const events = [];
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
  return { ws, cdp, events, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }), clearEvents: () => events.length = 0 };
}

const TEST_HTML = '<!DOCTYPE html><html><body>' +
  '<input id="testInput">' +
  '<button id="testBtn" onclick="fetch(\'/api\').then(r=>r.text()).then(t=>document.getElementById(\'result\').textContent=t)">Fetch</button>' +
  '<div id="result">none</div>' +
  '<script>window.__keys=[];document.getElementById("testInput").addEventListener("keydown",function(e){window.__keys.push(e.key)})</script>' +
  '</body></html>';

let chromeProc, webServer, configOriginal;
let passed = 0, failed = 0;
function record(label, pass, detail) {
  if (pass) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log(`\n=== 有头验证: 端口池 ${POOL_PORT} ===\n`);

  try {
    webServer = http.createServer((req, res) => {
      if (req.url.startsWith('/api')) { res.writeHead(200); res.end('api-ok'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    await new Promise(r => webServer.listen(WEB_PORT, r));

    // 确认端口池端口活着
    const ver = await httpGet(POOL_PORT, '/json/version');
    if (!ver) throw new Error('Pool port not responding');
    console.log(`Pool port ${POOL_PORT} ready\n`);

    const profile = `/tmp/cdp-headed-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    await sleep(2000);

    // 连端口池
    const client = makeClient(POOL_PORT);
    await client.open;

    const ct = await client.cdp('Target.createTarget', { url: `http://localhost:${WEB_PORT}/` });
    record('createTarget', !!ct?.targetId);

    if (ct?.targetId) {
      const at = await client.cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
      const sid = at.sessionId;
      await client.cdp('Page.enable', {}, sid);
      await client.cdp('Runtime.enable', {}, sid);
      await client.cdp('Network.enable', {}, sid);
      await sleep(2000);

      // === Network ===
      // 重新 navigate 触发网络请求（确保 Network.enable 已经生效）
      client.clearEvents();
      await client.cdp('Page.navigate', { url: `http://localhost:${WEB_PORT}/` }, sid);
      await sleep(2000);

      const navNetEvents = client.events.filter(e => e.method === 'Network.requestWillBeSent');
      record('Network.requestWillBeSent (navigate)', navNetEvents.length > 0, `events=${navNetEvents.length}`);

      // 触发 fetch
      client.clearEvents();
      const coords = JSON.parse((await client.cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({x:Math.round(document.getElementById("testBtn").getBoundingClientRect().x+30),y:Math.round(document.getElementById("testBtn").getBoundingClientRect().y+10)})',
        returnByValue: true
      }, sid)).result.value);
      await client.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
      await client.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
      await sleep(1000);

      const netEvents = client.events.filter(e => e.method === 'Network.requestWillBeSent');
      record('Network.requestWillBeSent', netEvents.length > 0, `events=${netEvents.length}`);

      const fetchResult = await client.cdp('Runtime.evaluate', {
        expression: 'document.getElementById("result").textContent', returnByValue: true
      }, sid);
      record('fetch 结果', fetchResult.result.value === 'api-ok', `value=${fetchResult.result.value}`);

      // === dispatchKeyEvent ===
      await client.cdp('Runtime.evaluate', { expression: 'document.getElementById("testInput").focus()' }, sid);
      await client.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' }, sid);
      await client.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, sid);
      await sleep(500);
      const keyVal = await client.cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({val:document.getElementById("testInput").value,keys:window.__keys})',
        returnByValue: true
      }, sid);
      const keyResult = JSON.parse(keyVal.result.value);
      record('dispatchKeyEvent 值', keyResult.val === 'a', `val=${keyResult.val}`);
      record('dispatchKeyEvent 键序列', JSON.stringify(keyResult.keys) === JSON.stringify(['a']), `keys=${JSON.stringify(keyResult.keys)}`);

      // === mouse click ===
      record('mouse click → fetch', fetchResult.result.value === 'api-ok');

      // === screencast ===
      client.clearEvents();
      await client.cdp('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 200, maxHeight: 200 }, sid);
      // 触发页面变化（screencast 变化检测需要 DOM 变化）
      await client.cdp('Runtime.evaluate', { expression: 'document.body.style.background="#ff0000"; document.body.innerHTML+="<div>change</div>"' }, sid);
      await sleep(3000);
      // ack 帧
      const frame = client.events.find(e => e.method === 'Page.screencastFrame');
      if (frame) {
        await client.cdp('Page.screencastFrameAck', { sessionId: frame.params.sessionId }, sid);
      }
      await sleep(1000);
      await client.cdp('Page.stopScreencast', {}, sid);
      const frames = client.events.filter(e => e.method === 'Page.screencastFrame');
      record('startScreencast 帧数', frames.length > 0, `frames=${frames.length}`);

      // === screenshot ===
      const shot = await client.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sid);
      record('captureScreenshot', !!shot?.data, `len=${shot?.data?.length || 0}`);

      await client.cdp('Target.closeTarget', { targetId: ct.targetId }).catch(() => {});
    }

    client.ws.close();
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    failed++;
  } finally {
    if (webServer) webServer.close();
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
