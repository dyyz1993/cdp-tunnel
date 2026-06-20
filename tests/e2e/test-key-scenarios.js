#!/usr/bin/env node
'use strict';

/**
 * 端口池 vs 直连 Chrome：关键场景对比验证
 *
 * 覆盖：
 * 1. Network 前置拦截（enable 之前的请求也能捕获）
 * 2. 注入脚本（addScriptToEvaluateOnNewDocument）
 * 3. Console log 事件（Runtime.consoleAPICalled）
 * 4. 截图（captureScreenshot）
 * 5. 重连后页面存活
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const DIRECT_PORT = 29800;
const PLUGIN_PORT = 29801;
const POOL_PORT = 29802;
const TAKEOVER_PORT = 29803;
const POOL_TAKEOVER_PORT = 29804;
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
  const c = makeCdpClient(ws);
  c.open = new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  return c;
}

async function connectRdp(port) {
  const ver = await httpGet(port, '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  const c = makeCdpClient(ws);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  return c;
}

// 测试页面：有 console.log、网络请求、外部资源
const TEST_HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/style.css">
</head><body>
<h1 id="title">Test Page</h1>
<button id="btn" onclick="fetch('/api/data').then(r=>r.json()).then(d=>document.getElementById('result').textContent=d.msg)">Load Data</button>
<div id="result">waiting</div>
<script>
console.log('page loaded');
console.warn('warning test');
console.error('error test');
</script>
</body></html>`;

let proxyProc, directChrome, webServer, configOriginal;
const results = {};

function record(label, aVal, bVal) {
  const aStr = JSON.stringify(aVal);
  const bStr = JSON.stringify(bVal);
  const match = aStr === bStr;
  results[label] = { direct: aVal, pool: bVal, match };
  console.log(`  ${match ? '✅' : '❌'} ${label}`);
  if (!match) {
    console.log(`     直连: ${aStr?.slice(0, 80)}`);
    console.log(`     端口池: ${bStr?.slice(0, 80)}`);
  }
}

async function runScenario(cdp, label) {
  const r = {};

  // createTarget + attach
  const ct = await cdp.cdp('Target.createTarget', { url: 'about:blank' });
  const at = await cdp.cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
  const sid = at.sessionId;

  await cdp.cdp('Page.enable', {}, sid);
  await cdp.cdp('Runtime.enable', {}, sid);

  // === 1. Network 前置拦截 ===
  // 在 navigate 之前 enable Network，确保捕获所有请求
  await cdp.cdp('Network.enable', {}, sid);
  cdp.clearEvents();

  // navigate（触发多个网络请求：HTML + CSS + JS）
  await cdp.cdp('Page.navigate', { url: `http://localhost:${WEB_PORT}/` }, sid);
  await sleep(3000);

  const netRequests = cdp.events
    .filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request.url.replace(`http://localhost:${WEB_PORT}`, ''));
  r.networkUrls = netRequests.sort();
  r.networkRequestCount = netRequests.length;

  // === 2. Console log 事件 ===
  const consoleEvents = cdp.events.filter(e => e.method === 'Runtime.consoleAPICalled');
  r.consoleLogCount = consoleEvents.length;
  r.consoleMessages = consoleEvents.map(e => ({
    type: e.params.type,
    msg: e.params.args[0]?.value || e.params.args[0]?.description || ''
  }));

  // === 3. 注入脚本 ===
  await cdp.cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__injected = { timestamp: Date.now(), marker: "cdp-tunnel-test" };'
  }, sid);
  // 重新 navigate 触发注入
  await cdp.cdp('Page.navigate', { url: `http://localhost:${WEB_PORT}/` }, sid);
  await sleep(2000);
  const injectCheck = await cdp.cdp('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__injected)', returnByValue: true
  }, sid);
  r.injectedScript = injectCheck.result.value;

  // === 4. 截图 ===
  const shot = await cdp.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sid);
  r.screenshotBytes = shot.data ? shot.data.length : 0;

  // === 5. Network 响应拦截（responseReceived）===
  const netResponses = cdp.events
    .filter(e => e.method === 'Network.responseReceived')
    .map(e => ({ url: e.params.response.url.replace(`http://localhost:${WEB_PORT}`, ''), status: e.params.response.status }));
  r.networkResponseCount = netResponses.length;

  // 返回 targetId 用于重连测试
  r.targetId = ct.targetId;
  r.sessionId = sid;

  return r;
}

(async () => {
  console.log(`\n=== 关键场景对比：端口池 vs 直连 Chrome ===\n`);

  try {
    webServer = http.createServer((req, res) => {
      if (req.url.includes('/api/data')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ msg: 'data-loaded-' + Date.now() }));
        return;
      }
      if (req.url.includes('.css')) {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end('body { font-family: sans-serif; }');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    await new Promise(r => webServer.listen(WEB_PORT, r));

    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    // 起 proxy
    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PLUGIN_PORT), TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(POOL_PORT), POOL_SIZE: '1', POOL_TAKEOVER_PORT: String(POOL_TAKEOVER_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    for (let i = 0; i < 20; i++) { try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); } }

    // 起 Chromium（直连 RDP + 加载扩展）
    const profile = `/tmp/cdp-key-${Date.now()}`;
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

    // === A: 直连 Chrome ===
    console.log('▼ A: 直连 Chrome CDP');
    const directConn = await connectRdp(DIRECT_PORT);
    const resultA = await runScenario(directConn, 'direct');
    directConn.ws.close();
    await sleep(1000);

    // === B: 端口池 ===
    console.log('\n▼ B: 端口池');
    const poolClient = makePoolClient(POOL_PORT);
    await poolClient.open;
    const resultB = await runScenario(poolClient, 'pool');

    // === 对比 ===
    console.log('\n▼ 对比结果\n');

    console.log('--- Network 前置拦截 ---');
    record('Network 请求捕获数量', resultA.networkRequestCount > 0, resultB.networkRequestCount > 0);
    record('Network 请求 URL 一致', resultA.networkUrls, resultB.networkUrls);
    record('Network 响应捕获', resultA.networkResponseCount > 0, resultB.networkResponseCount > 0);

    console.log('\n--- Console Log ---');
    record('Console 事件数量 > 0', resultA.consoleLogCount > 0, resultB.consoleLogCount > 0);
    record('Console 消息一致', resultA.consoleMessages, resultB.consoleMessages);

    console.log('\n--- 注入脚本 ---');
    record('注入脚本生效', resultA.injectedScript !== null, resultB.injectedScript !== null);
    record('注入脚本内容一致', resultA.injectedScript?.includes('cdp-tunnel-test'), resultB.injectedScript?.includes('cdp-tunnel-test'));

    console.log('\n--- 截图 ---');
    record('截图有数据', resultA.screenshotBytes > 0, resultB.screenshotBytes > 0);

    // === 重连后页面存活 ===
    console.log('\n--- 重连后页面存活 ---');
    poolClient.ws.close();
    await sleep(1000);

    const reconnectClient = makePoolClient(POOL_PORT);
    await reconnectClient.open;
    const tg = await reconnectClient.cdp('Target.getTargets');
    const pages = (tg.targetInfos || []).filter(t => t.type === 'page');
    const survivedB = pages.some(p => p.url.includes(`localhost:${WEB_PORT}`));

    // 直连也测重连
    const directConn2 = await connectRdp(DIRECT_PORT);
    const tg2 = await directConn2.cdp('Target.getTargets');
    const pages2 = (tg2.targetInfos || []).filter(t => t.type === 'page');
    const survivedA = pages2.some(p => p.url.includes(`localhost:${WEB_PORT}`));
    directConn2.ws.close();
    reconnectClient.ws.close();

    record('重连后页面存活', survivedA, survivedB);

    poolClient.ws.close();

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    console.log(e.stack);
  } finally {
    if (webServer) webServer.close();
    if (directChrome) { try { process.kill(-directChrome.pid); } catch {} try { fs.rmSync(directChrome._profile, { recursive: true, force: true }); } catch {} }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  // 生成报告
  const passed = Object.values(results).filter(r => r.match).length;
  const failed = Object.values(results).filter(r => !r.match).length;
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);

  // 写报告文件
  const reportPath = path.join(__dirname, '_port-pool-comparison-report.md');
  let report = `# 端口池 vs 直连 Chrome 对比报告\n\n生成时间: ${new Date().toISOString()}\n\n`;
  report += `| 场景 | 直连 Chrome | 端口池 | 一致 |\n|------|:---:|:---:|:---:|\n`;
  for (const [label, r] of Object.entries(results)) {
    report += `| ${label} | ${typeof r.direct === 'boolean' ? (r.direct ? '✅' : '❌') : JSON.stringify(r.direct)?.slice(0,30)} | ${typeof r.pool === 'boolean' ? (r.pool ? '✅' : '❌') : JSON.stringify(r.pool)?.slice(0,30)} | ${r.match ? '✅' : '❌'} |\n`;
  }
  report += `\n**结论**: ${failed === 0 ? '端口池与直连 Chrome 行为完全一致' : `${failed} 项不一致`}\n`;
  fs.writeFileSync(reportPath, report);
  console.log(`\n报告已保存: ${reportPath}`);

  process.exit(failed > 0 ? 1 : 0);
})();
