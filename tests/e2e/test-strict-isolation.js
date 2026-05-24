/**
 * TDD: 严格隔离测试
 *
 * 规则：
 * 1. CDP 客户端只能看到自己创建的页面
 * 2. 用户页面完全不可见（getTargets / pages() / events）
 * 3. 其他 CDP 客户端的页面完全不可见
 * 4. 断连 = 关闭该客户端的 tab group
 */

const http = require('http');
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws');

const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitForPort(port, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume(); resolve(true);
      }).on('error', () => {
        if (Date.now() - start > timeout) resolve(false);
        else setTimeout(check, 500);
      });
    };
    check();
  });
}
function httpGet(port, path_) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path_}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    }).on('error', reject);
  });
}
function sendCDP(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = Date.now() + Math.random();
    ws.send(JSON.stringify({ id, method, params }));
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

(async () => {
  let passed = 0, failed = 0;
  const PORT = 10000 + Math.floor(Math.random() * 50000);
  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`));

  const proxyProc = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (!await waitForPort(PORT)) {
    console.log('[FAIL] Proxy failed');
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }

  // Start Chrome with USER pages already open
  const profile = `/tmp/cdp-strict-iso-${Date.now()}`;
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });

  await sleep(10000);
  let extReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpGet(PORT, '/json/list');
      if ((list || []).filter(t => t.type === 'page').length > 0) { extReady = true; break; }
    } catch {}
    await sleep(2000);
  }
  if (!extReady) {
    console.log('[FAIL] Extension not connected');
    try { process.kill(-chromeProc.pid); } catch {}
    proxyProc.kill();
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }

  // ── Test 1: getTargets 隔离 ──
  console.log('\n[Test 1] CDP 客户端 getTargets 不应看到用户页面');
  const wsA = new WebSocket(`ws://localhost:${PORT}/client`);
  await new Promise((r, e) => { wsA.on('open', r); wsA.on('error', e); });
  await sendCDP(wsA, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(1000);

  const targetsA = await sendCDP(wsA, 'Target.getTargets');
  const pagesA = (targetsA?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client A getTargets: ${pagesA.length} pages`);
  pagesA.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));

  const allOwnedByA = pagesA.every(p => p.url === 'about:blank');
  if (pagesA.length >= 1 && allOwnedByA) {
    console.log('[PASS] Client A 只看到自己的 auto-default-page，看不到用户页面');
    passed++;
  } else {
    console.log(`[FAIL] Client A 看到了 ${pagesA.length} 个页面，包含非 about:blank 页面`);
    failed++;
  }

  // ── Test 2: Client A 创建页面后只看到自己的 ──
  console.log('\n[Test 2] Client A 创建页面后只看到自己的');
  const createResult = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
  const aTabId = createResult?.result?.targetId;
  console.log(`  Client A created: ${aTabId}`);
  await sleep(2000);

  const targetsA2 = await sendCDP(wsA, 'Target.getTargets');
  const pagesA2 = (targetsA2?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client A getTargets now: ${pagesA2.length} pages`);

  const hasCreatedTab = pagesA2.some(p => p.targetId === aTabId);
  if (pagesA2.length === 2 && hasCreatedTab) {
    console.log('[PASS] Client A 看到 2 个页面（auto-default + 手动创建）');
    passed++;
  } else {
    console.log(`[FAIL] Client A 看到了 ${pagesA2.length} 个页面（应该看到 2 个）`);
    pagesA2.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));
    failed++;
  }

  // ── Test 3: Client B 看不到 Client A 的页面 ──
  console.log('\n[Test 3] Client B 看不到 Client A 的页面');
  const wsB = new WebSocket(`ws://localhost:${PORT}/client`);
  await new Promise((r, e) => { wsB.on('open', r); wsB.on('error', e); });
  await sendCDP(wsB, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(1000);

  const targetsB = await sendCDP(wsB, 'Target.getTargets');
  const pagesB = (targetsB?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client B getTargets: ${pagesB.length} pages`);
  pagesB.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));

  const hasATab = pagesB.some(p => p.targetId === aTabId);
  if (!hasATab && pagesB.length >= 1) {
    console.log('[PASS] Client B 看不到 Client A 的页面，只看到自己的 auto-default-page');
    passed++;
  } else if (hasATab) {
    console.log(`[FAIL] Client B 看到了 Client A 的页面！`);
    failed++;
  } else {
    console.log(`[FAIL] Client B 看到了 ${pagesB.length} 个页面（异常）`);
    failed++;
  }

  // ── Test 4: Client B 创建自己的页面，A 看不到 ──
  console.log('\n[Test 4] Client B 创建页面后，Client A 看不到');
  const createB = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
  const bTabId = createB?.result?.targetId;
  console.log(`  Client B created: ${bTabId}`);
  await sleep(2000);

  const targetsA3 = await sendCDP(wsA, 'Target.getTargets');
  const pagesA3 = (targetsA3?.result?.targetInfos || []).filter(t => t.type === 'page');

  if (!pagesA3.find(p => p.targetId === bTabId) && pagesA3.length === 2) {
    console.log('[PASS] Client A 仍然只看到自己的 2 个页面，看不到 B 的');
    passed++;
  } else {
    console.log(`[FAIL] Client A 看到了 B 的页面或数量不对: ${pagesA3.length}`);
    failed++;
  }

  // ── Test 5: Playwright pages() 隔离 ──
  console.log('\n[Test 5] Playwright pages() 隔离');
  const browserC = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 10000 });
  const ctxC = browserC.contexts()[0];
  const pagesC = ctxC.pages();
  console.log(`  Playwright Client C pages(): ${pagesC.length}`);
  pagesC.forEach((p, i) => console.log(`    page[${i}]: ${p.url().substring(0, 60)}`));

  const noForeignPages = pagesC.every(p => p.url() === 'about:blank');
  if (pagesC.length >= 1 && noForeignPages) {
    console.log('[PASS] Playwright 只看到自己的 auto-default-page，看不到用户/A/B 的页面');
    passed++;
  } else {
    console.log(`[FAIL] Playwright 看到了不属于自己或非 about:blank 的页面`);
    failed++;
  }

  // ── Test 6: Playwright 创建页面后只看到自己的 ──
  console.log('\n[Test 6] Playwright 创建页面后只看到自己的');
  const pC = await ctxC.newPage();
  await pC.goto('https://www.example.com');
  const pagesC2 = ctxC.pages();
  console.log(`  Playwright pages() after newPage: ${pagesC2.length}`);

  if (pagesC2.length === 2) {
    console.log('[PASS] Playwright 看到 2 个页面（auto-default + newPage）');
    passed++;
  } else {
    console.log(`[FAIL] Playwright 看到了 ${pagesC2.length} 个页面（应该是 2）`);
    failed++;
  }
  await browserC.close();

  // ── Test 7: setAutoAttach events 隔离 ──
  console.log('\n[Test 7] setAutoAttach 只为自己创建的页面发事件');
  const wsD = new WebSocket(`ws://localhost:${PORT}/client`);
  await new Promise((r, e) => { wsD.on('open', r); wsD.on('error', e); });

  let attachedEvents = [];
  wsD.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Target.attachedToTarget') {
      attachedEvents.push(msg.params?.targetInfo?.targetId);
    }
  });

  await sendCDP(wsD, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(2000);

  console.log(`  Client D received ${attachedEvents.length} attachedToTarget events`);
  if (attachedEvents.length === 1) {
    console.log('[PASS] Client D 只收到 1 个事件（自己的 auto-default-page）');
    passed++;
  } else {
    console.log(`[FAIL] Client D 收到了 ${attachedEvents.length} 个事件（应该是 1，只应有自己的 auto-default-page）`);
    failed++;
  }

  // Cleanup
  wsA.close(); wsB.close(); wsD.close();
  try { process.kill(-chromeProc.pid); } catch {}
  proxyProc.kill();
  fs.writeFileSync(CONFIG_PATH, configOriginal);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
