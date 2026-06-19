#!/usr/bin/env node
'use strict';

/**
 * Input.dispatchKeyEvent / dispatchMouseEvent 在隔离 tab 上的投递测试
 *
 * 根因：cdp-tunnel 隔离 tab 默认 visibility=hidden（active:false + 折叠分组），
 * Chromium 在此状态下丢弃合成输入事件（keyboard/mouse）。
 * forward.js 的 ensureVisible 修复了这个问题——在发合成事件前自动
 * Page.bringToFront + 恢复焦点。
 *
 * 验证：
 * 1. Input.dispatchKeyEvent → keydown 事件到达 DOM
 * 2. Input.dispatchMouseEvent → click 事件到达 DOM
 * 3. Input.insertText → input 事件到达 DOM（对照，不需 visible）
 * 4. textarea Enter → submit 触发
 *
 * 独立测试端口，绝不占用 9221/9222。
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

const PORT = parseInt(process.env.PORT || '0', 10) || (10000 + Math.floor(Math.random() * 50000));
const BENCH_PORT = 20000 + Math.floor(Math.random() * 9999);

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

let _id = 1;
const pending = new Map();
function setupRouter(ws) {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {}
  });
}
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _id++;
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout: ' + method)); } }, 20000);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function cdp(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = _id++;
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout: ' + method)); } }, 20000);
    const req = { id, method, params };
    if (sessionId) req.sessionId = sessionId;
    ws.send(JSON.stringify(req));
  });
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

let proxyProc, chromeProc, benchProc, ws, configOriginal;
let passed = 0, failed = 0;

function record(label, pass) {
  if (pass) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

(async () => {
  console.log(`\n[Input Event Delivery] PORT=${PORT}`);

  try {
    // 备份/改 config
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/,
      `WS_URL: 'ws://localhost:${PORT}/plugin'`
    ));

    // 起 proxy
    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });

    let proxyReady = false;
    for (let i = 0; i < 20; i++) {
      try { await httpGet(PORT, '/json/version'); proxyReady = true; break; } catch { await sleep(500); }
    }
    if (!proxyReady) throw new Error('Proxy failed to start');

    // 起 bench server（用 base64 编码的 HTML，避免转义问题）
    const BENCH_HTML = Buffer.from(
      '<!DOCTYPE html><html><body>' +
      '<input id="testInput"><button id="testBtn">btn</button>' +
      '<textarea id="testTextarea"></textarea>' +
      '<scr' + 'ipt>' +
      'window.__antiLog=[];' +
      'function log(m){window.__antiLog.push({ts:Date.now(),msg:m})}' +
      'window.__antiGetLog=function(){return JSON.stringify(window.__antiLog)};' +
      'window.__antiClearLog=function(){window.__antiLog=[]};' +
      'document.getElementById("testInput").addEventListener("keydown",function(e){log("INPUT KEYDOWN|isTrusted="+e.isTrusted+"|key="+e.key)});' +
      'document.getElementById("testInput").addEventListener("input",function(e){log("INPUT|isTrusted="+e.isTrusted+"|val="+e.target.value)});' +
      'document.getElementById("testBtn").addEventListener("click",function(e){log("CLICK|isTrusted="+e.isTrusted)});' +
      'document.getElementById("testTextarea").addEventListener("keydown",function(e){log("TEXTAREA keydown|key="+e.key)});' +
      '</scr' + 'ipt></body></html>'
    ).toString('base64');
    const benchScript = path.join(__dirname, `_bench-input-${Date.now()}.js`);
    fs.writeFileSync(benchScript, `
const http=require('http');
const HTML=Buffer.from('${BENCH_HTML}','base64').toString();
http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(HTML)}).listen(${BENCH_PORT});
`);
    benchProc = spawn(process.execPath, [benchScript], { stdio: ['pipe', 'pipe', 'pipe'] });
    benchProc._scriptPath = benchScript;
    let benchOk = false;
    for (let i = 0; i < 15; i++) {
      try {
        await new Promise((resolve, reject) => {
          http.get(`http://localhost:${BENCH_PORT}/`, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
        });
        benchOk = true; break;
      } catch { await sleep(400); }
    }
    if (!benchOk) throw new Error('Bench server failed');

    // 起 Chromium
    const profile = `/tmp/cdp-input-test-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      'about:blank'
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    chromeProc._profile = profile;
    let chromeStderr = '';
    chromeProc.stderr.on('data', d => { chromeStderr += d.toString(); });
    chromeProc.on('exit', (code) => {
      if (code !== null && code !== 0) console.log(`[WARN] Chromium exited code=${code}`);
    });
    await sleep(4000);
    if (chromeProc.exitCode !== null) {
      throw new Error('Chromium exited immediately: ' + chromeStderr.slice(-300));
    }

    // 等扩展连接（用 /json/version 检查，和现有测试一致）
    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try {
        const ver = await httpGet(PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect (waited 180s)');

    // 连 client
    ws = await openClient(PORT);
    setupRouter(ws);
    await sleep(500);

    // 创建隔离 tab
    await send(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(1500);
    const tg = await send(ws, 'Target.getTargets');
    const pages = (tg?.targetInfos || []).filter(t => t.type === 'page');
    if (pages.length === 0) throw new Error('No isolated page created');
    const target = pages[pages.length - 1];
    const sessionId = (await send(ws, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;

    await cdp(ws, 'Page.enable', {}, sessionId);
    await cdp(ws, 'Runtime.enable', {}, sessionId);
    await cdp(ws, 'Page.navigate', { url: `http://localhost:${BENCH_PORT}/` }, sessionId);
    await sleep(2500);

    const ev = async (expr) => (await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result.value;
    const getLog = async () => JSON.parse(await ev('window.__antiGetLog()'));
    const clearLog = async () => { await ev('window.__antiClearLog()'); };

    // 测试 1: dispatchKeyEvent
    await ev('document.getElementById("testInput").focus()');
    await sleep(200);
    await clearLog();
    try {
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, sessionId);
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, sessionId);
    } catch (e) {}
    await sleep(400);
    const l1 = await getLog();
    record('Input.dispatchKeyEvent → keydown', l1.some(e => e.msg.includes('INPUT KEYDOWN')));

    // 测试 2: insertText（对照）
    await ev('document.getElementById("testInput").value=""; document.getElementById("testInput").focus()');
    await sleep(200);
    await clearLog();
    try { await cdp(ws, 'Input.insertText', { text: 'xy' }, sessionId); } catch (e) {}
    await sleep(400);
    const l2 = await getLog();
    record('Input.insertText → input', l2.some(e => e.msg.includes('INPUT')));

    // 测试 3: dispatchMouseEvent (click)
    const coords = JSON.parse(await ev('(()=>{const r=document.getElementById("testBtn").getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()'));
    await clearLog();
    try {
      await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y }, sessionId);
      await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sessionId);
      await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sessionId);
    } catch (e) {}
    await sleep(400);
    const l3 = await getLog();
    record('Input.dispatchMouseEvent → click', l3.some(e => e.msg.includes('CLICK')));

    // 测试 4: textarea Enter → submit
    await clearLog();
    await ev('document.getElementById("testTextarea").focus()');
    try {
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
      await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    } catch (e) {}
    await sleep(400);
    const l4 = await getLog();
    record('textarea Enter → keydown', l4.some(e => e.msg.includes('TEXTAREA keydown') && e.msg.includes('Enter')));

    ws.close();
    ws = null;
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    failed++;
  } finally {
    if (ws) try { ws.close(); } catch {}
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
    if (benchProc) {
      try { benchProc.kill(); } catch {}
      try { fs.rmSync(benchProc._scriptPath); } catch {}
    }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
