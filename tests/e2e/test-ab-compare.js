#!/usr/bin/env node
'use strict';

/**
 * A/B 对比测试：直连 Chrome CDP vs cdp-tunnel 端口池
 *
 * 同一个 Chromium 实例，同一个页面，同一套 CDP 操作：
 *   A: 直连 --remote-debugging-port（原生 Chrome CDP）
 *   B: cdp-tunnel 端口池（PortPoolManager）
 *
 * 断言两边结果一致。这是兼容性的终极验证。
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

const DIRECT_PORT = 29400;      // 直连 Chrome RDP
const PLUGIN_PORT = DIRECT_PORT + 1;
const POOL_PORT = DIRECT_PORT + 2;  // 端口池 create 端口
const TAKEOVER_PORT = DIRECT_PORT + 10;

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

function makeClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
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
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

function connectRdp(port) {
  return new Promise(async (resolve, reject) => {
    const ver = await httpGet(port, '/json/version');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const pending = new Map();
    let id = 1;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: e } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) e(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
    function cdp(method, params = {}, sessionId) {
      return new Promise((res, rej) => {
        const i = id++;
        pending.set(i, { resolve: res, reject: rej });
        setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('Timeout: ' + method)); } }, 20000);
        const o = { id: i, method, params };
        if (sessionId) o.sessionId = sessionId;
        ws.send(JSON.stringify(o));
      });
    }
    ws.on('open', () => resolve({ ws, cdp }));
    ws.on('error', reject);
  });
}

// 测试页 HTML（http server 提供，避免 data URL 限制）
const TEST_HTML = '<!DOCTYPE html><html><body>' +
  '<input id="testInput">' +
  '<button id="testBtn" onclick="document.getElementById(\'result\').textContent=\'clicked\'">Click Me</button>' +
  '<div id="result">none</div>' +
  '<script>window.__keys=[];document.getElementById("testInput").addEventListener("keydown",function(e){window.__keys.push(e.key)})</script>' +
  '</body></html>';

let proxyProc, chromeProc, targetServer, configOriginal;
let passed = 0, failed = 0;
const mismatches = [];

function record(label, aVal, bVal) {
  const match = JSON.stringify(aVal) === JSON.stringify(bVal);
  if (match) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    mismatches.push({ label, aVal, bVal });
    console.log(`  ❌ ${label}`);
    console.log(`     直连: ${JSON.stringify(aVal).slice(0, 80)}`);
    console.log(`     端口池: ${JSON.stringify(bVal).slice(0, 80)}`);
  }
}

/**
 * 在一个 CDP 连接上跑完整的测试操作序列，返回结果对象
 */
async function runCdpSequence(cdp, createTarget) {
  const results = {};

  // 1. createTarget
  const ct = await createTarget();
  results.createdTarget = !!ct.targetId;
  const targetId = ct.targetId;

  // 2. attach
  const at = await cdp('Target.attachToTarget', { targetId, flatten: true });
  results.attachedSession = !!at.sessionId;
  const sid = at.sessionId;

  // 3. enable domains
  await cdp('Page.enable', {}, sid);
  await cdp('Runtime.enable', {}, sid);
  await sleep(500);

  // 4. navigate 到测试页
  const nav = await cdp('Page.navigate', { url: `http://localhost:${DIRECT_PORT + 20}/test.html` }, sid);
  results.navigateError = nav.errorText || 'OK';
  await sleep(2000);

  // 5. evaluate: 读页面标题
  const evalTitle = await cdp('Runtime.evaluate', {
    expression: 'document.querySelector("#result") ? document.querySelector("#result").textContent : "no result"',
    returnByValue: true
  }, sid);
  results.initialResult = evalTitle.result.value;

  // 6. insertText
  await cdp('Runtime.evaluate', { expression: 'document.getElementById("testInput").focus()' }, sid);
  await cdp('Input.insertText', { text: 'hello' }, sid);
  await sleep(300);
  const inputVal = await cdp('Runtime.evaluate', {
    expression: 'document.getElementById("testInput").value', returnByValue: true
  }, sid);
  results.insertTextResult = inputVal.result.value;

  // 7. dispatchKeyEvent（带 text 参数）
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, text: '!' }, sid);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1', windowsVirtualKeyCode: 49 }, sid);
  await sleep(300);
  const afterKey = await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({val:document.getElementById("testInput").value,keys:window.__keys})',
    returnByValue: true
  }, sid);
  results.keyEventResult = JSON.parse(afterKey.result.value);

  // 8. mouse click
  const coords = JSON.parse((await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({x:Math.round(document.getElementById("testBtn").getBoundingClientRect().x+30),y:Math.round(document.getElementById("testBtn").getBoundingClientRect().y+10)})',
    returnByValue: true
  }, sid)).result.value);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 }, sid);
  await sleep(500);
  const clickResult = await cdp('Runtime.evaluate', {
    expression: 'document.getElementById("result").textContent', returnByValue: true
  }, sid);
  results.clickResult = clickResult.result.value;

  // 9. screenshot
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sid);
  results.screenshotSize = shot.data ? shot.data.length : 0;

  // 清理
  await cdp('Target.closeTarget', { targetId }).catch(() => {});

  return results;
}

(async () => {
  console.log(`\n=== A/B 对比: 直连 Chrome CDP vs cdp-tunnel 端口池 ===\n`);

  try {
    // 起测试页 http server
    targetServer = require('http').createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    await new Promise(r => targetServer.listen(DIRECT_PORT + 20, r));

    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: {
        ...process.env,
        PORT: String(PLUGIN_PORT),
        TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(POOL_PORT),
        POOL_SIZE: '1',
        POOL_TAKEOVER_PORT: String(TAKEOVER_PORT),
        LOG_LEVEL: 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    for (let i = 0; i < 20; i++) {
      try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); }
    }

    // 起 Chromium（同时开直连 RDP 端口 + 加载扩展）
    const profile = `/tmp/cdp-ab-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--remote-debugging-port=${DIRECT_PORT}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    await sleep(4000);

    // 等扩展连接
    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try {
        const ver = await httpGet(PLUGIN_PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension + direct RDP both ready\n');

    // === A: 直连 Chrome CDP ===
    console.log('▼ A: 直连 Chrome CDP (port ' + DIRECT_PORT + ')');
    const directConn = await connectRdp(DIRECT_PORT);
    const resultA = await runCdpSequence(directConn.cdp, () =>
      directConn.cdp('Target.createTarget', { url: 'about:blank' })
    );
    directConn.ws.close();
    console.log('');

    await sleep(1000);

    // === B: cdp-tunnel 端口池 ===
    console.log('▼ B: cdp-tunnel 端口池 (port ' + POOL_PORT + ')');
    const poolClient = makeClient(POOL_PORT);
    await poolClient.open;
    const resultB = await runCdpSequence(poolClient.cdp, () =>
      poolClient.cdp('Target.createTarget', { url: 'about:blank' })
    );
    poolClient.ws.close();
    console.log('');

    // === 对比 ===
    console.log('▼ 对比结果\n');
    record('createTarget 成功', resultA.createdTarget, resultB.createdTarget);
    record('attachToTarget 成功', resultA.attachedSession, resultB.attachedSession);
    record('navigate 无错误', resultA.navigateError, resultB.navigateError);
    record('初始 DOM 读取', resultA.initialResult, resultB.initialResult);
    record('insertText 结果', resultA.insertTextResult, resultB.insertTextResult);
    record('dispatchKeyEvent 值', resultA.keyEventResult.val, resultB.keyEventResult.val);
    record('dispatchKeyEvent 键序列', resultA.keyEventResult.keys, resultB.keyEventResult.keys);
    record('mouse click 结果', resultA.clickResult, resultB.clickResult);
    record('screenshot 有数据', resultA.screenshotSize > 0, resultB.screenshotSize > 0);

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    console.log(e.stack);
    failed++;
  } finally {
    if (targetServer) targetServer.close();
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
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
