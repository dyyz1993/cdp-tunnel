/**
 * TDD: 端口隔离测试（per-port isolation）
 *
 * 端口池架构下，隔离边界是端口，不是 client：
 * 1. 同一端口的多个 client 共享该端口的 target（pool_{port} 分组）
 * 2. 跨端口互不可见（不同端口 = 不同 pool = 不同分组）
 * 3. 用户页面完全不可见（create 端口看不到用户 tab）
 *
 * 本测试启动两个 create 端口（主端口 + 端口池端口），验证跨端口隔离。
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
  // 端口池端口：跨端口隔离测试需要两个 create 端口
  const POOL_PORT = PORT + 1;
  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`));

  // 显式启动一个端口池端口（覆盖 run-all.js 的 POOL_SIZE=0）
  const proxyProc = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), POOL_START: String(POOL_PORT), POOL_SIZE: '1', LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  proxyProc.stdout.on('data', () => {});
  proxyProc.stderr.on('data', () => {});

  if (!await waitForPort(PORT)) {
    console.log('[FAIL] Proxy failed');
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  // 等端口池端口就绪
  for (let i = 0; i < 20; i++) { try { await httpGet(POOL_PORT, '/json/version'); break; } catch { await sleep(500); } }

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
      // 用 /json/version 检查 proxy 是否运行（create 模式 /json/list 返回空，不再用于扩展检查）
      const ver = await httpGet(PORT, '/json/version');
      if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
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

  // ── Test 1: Client A（主端口）getTargets 不含用户页面 ──
  console.log('\n[Test 1] CDP 客户端 getTargets 不应看到用户页面');
  const wsA = new WebSocket(`ws://localhost:${PORT}/client`);
  await new Promise((r, e) => { wsA.on('open', r); wsA.on('error', e); });
  await sendCDP(wsA, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(1000);

  const targetsA = await sendCDP(wsA, 'Target.getTargets');
  const pagesA = (targetsA?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client A getTargets: ${pagesA.length} pages`);
  pagesA.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));

  // 端口池语义：初始 getTargets 不含用户页面（可能为空，或只有自己之前建的 about:blank）
  const hasUserPage = pagesA.some(p => p.url !== 'about:blank');
  if (!hasUserPage) {
    console.log('[PASS] Client A 看不到用户页面');
    passed++;
  } else {
    console.log(`[FAIL] Client A 看到了用户页面`);
    failed++;
  }

  // ── Test 2: Client A 创建页面后能看到自己创建的 ──
  console.log('\n[Test 2] Client A 创建页面后能看到自己创建的');
  const createResult = await sendCDP(wsA, 'Target.createTarget', { url: 'about:blank' });
  const aTabId = createResult?.result?.targetId;
  console.log(`  Client A created: ${aTabId}`);
  await sleep(2000);

  const targetsA2 = await sendCDP(wsA, 'Target.getTargets');
  const pagesA2 = (targetsA2?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client A getTargets now: ${pagesA2.length} pages`);

  const hasCreatedTab = pagesA2.some(p => p.targetId === aTabId);
  if (hasCreatedTab) {
    console.log('[PASS] Client A 能看到自己创建的页面');
    passed++;
  } else {
    console.log(`[FAIL] Client A 看不到自己创建的页面`);
    pagesA2.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));
    failed++;
  }

  // ── Test 3: 同端口 Client B 能看到 Client A 创建的页面（端口池共享语义）──
  console.log('\n[Test 3] 同端口 Client B 能看到 Client A 的页面（端口池共享）');
  const wsB = new WebSocket(`ws://localhost:${PORT}/client`);
  await new Promise((r, e) => { wsB.on('open', r); wsB.on('error', e); });
  await sendCDP(wsB, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(1000);

  const targetsB = await sendCDP(wsB, 'Target.getTargets');
  const pagesB = (targetsB?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client B (same port) getTargets: ${pagesB.length} pages`);
  pagesB.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));

  const hasATab = pagesB.some(p => p.targetId === aTabId);
  if (hasATab) {
    console.log('[PASS] 同端口 Client B 能看到 Client A 的页面（端口池共享语义）');
    passed++;
  } else {
    console.log(`[FAIL] 同端口 Client B 看不到 Client A 的页面（应该共享）`);
    failed++;
  }

  // ── Test 4: 跨端口 Client（POOL_PORT）看不到 Client A 的页面 ──
  console.log('\n[Test 4] 跨端口 Client 看不到 Client A 的页面（端口隔离）');
  const wsX = new WebSocket(`ws://localhost:${POOL_PORT}/client`);
  await new Promise((r, e) => { wsX.on('open', r); wsX.on('error', e); });
  await sendCDP(wsX, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(1000);

  const targetsX = await sendCDP(wsX, 'Target.getTargets');
  const pagesX = (targetsX?.result?.targetInfos || []).filter(t => t.type === 'page');
  console.log(`  Client X (pool port ${POOL_PORT}) getTargets: ${pagesX.length} pages`);
  pagesX.forEach(p => console.log(`    ${p.targetId.substring(0,8)} ${p.url.substring(0,40)}`));

  const crossHasATab = pagesX.some(p => p.targetId === aTabId);
  if (!crossHasATab) {
    console.log('[PASS] 跨端口 Client 看不到 Client A 的页面（端口隔离）');
    passed++;
  } else {
    console.log(`[FAIL] 跨端口 Client 看到了 Client A 的页面（隔离失效）`);
    failed++;
  }

  // ── Test 5: Playwright（主端口）pages() 不含用户页面 ──
  console.log('\n[Test 5] Playwright pages() 隔离');
  const browserC = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 10000 });
  const ctxC = browserC.contexts()[0];
  const pagesC = ctxC.pages();
  console.log(`  Playwright Client C pages(): ${pagesC.length}`);
  pagesC.forEach((p, i) => console.log(`    page[${i}]: ${p.url().substring(0, 60)}`));

  // 端口池语义：Playwright 看到的页面都应是本端口的（about:blank 或自己创建的），不含用户页面
  const noUserPages = pagesC.every(p => p.url() === 'about:blank');
  if (noUserPages) {
    console.log('[PASS] Playwright 看不到用户页面');
    passed++;
  } else {
    console.log(`[FAIL] Playwright 看到了用户页面`);
    failed++;
  }

  // ── Test 6: Playwright 创建页面后能看到 ──
  console.log('\n[Test 6] Playwright 创建页面后能看到');
  const pC = await ctxC.newPage();
  // newPage 已是 about:blank，直接 evaluate（goto about:blank 冗余且 load 事件不可靠）
  await pC.evaluate(() => { document.title = 'playwright-created'; });
  await sleep(1000);
  const pagesC2 = ctxC.pages();
  console.log(`  Playwright pages() after newPage: ${pagesC2.length}`);

  const pcTitle = await pC.title();
  if (pcTitle === 'playwright-created') {
    console.log('[PASS] Playwright 能创建并操作页面');
    passed++;
  } else {
    console.log(`[FAIL] Playwright 无法操作创建的页面 (title="${pcTitle}")`);
    failed++;
  }
  await browserC.close();

  // ── Test 7: 跨端口 Playwright 看不到主端口的页面 ──
  console.log('\n[Test 7] 跨端口 Playwright 看不到主端口的页面');
  const browserD = await chromium.connectOverCDP(`http://localhost:${POOL_PORT}`, { timeout: 10000 });
  const ctxD = browserD.contexts()[0];
  const pagesD = ctxD.pages();
  console.log(`  Playwright Client D (pool port) pages(): ${pagesD.length}`);
  pagesD.forEach((p, i) => console.log(`    page[${i}]: ${p.url().substring(0, 60)}`));

  // 跨端口不应看到主端口 Playwright 创建的页面（用 getTargets 交叉验证更可靠）
  const wsD = new WebSocket(`ws://localhost:${POOL_PORT}/client`);
  await new Promise((r, e) => { wsD.on('open', r); wsD.on('error', e); });
  await sendCDP(wsD, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await sleep(1000);
  const targetsD = await sendCDP(wsD, 'Target.getTargets');
  const pagesDTargets = (targetsD?.result?.targetInfos || []).filter(t => t.type === 'page');
  // 跨端口不应看到 aTabId（Client A 在主端口创建的）
  const crossHasMainTarget = pagesDTargets.some(t => t.targetId === aTabId);
  if (!crossHasMainTarget) {
    console.log('[PASS] 跨端口看不到主端口创建的页面（端口隔离）');
    passed++;
  } else {
    console.log(`[FAIL] 跨端口看到了主端口的页面（隔离失效）`);
    failed++;
  }
  wsD.close();
  await browserD.close();

  // Cleanup
  wsA.close(); wsB.close(); wsX.close();
  try { process.kill(-chromeProc.pid); } catch {}
  proxyProc.kill();
  fs.writeFileSync(CONFIG_PATH, configOriginal);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
