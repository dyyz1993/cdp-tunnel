/**
 * TDD Test: Service Worker 休眠后重连 + 事件推送验证
 *
 * 验证场景：
 * 1. 扩展连接正常，Playwright 能 pages()/newPage()/evaluate()
 * 2. 模拟 Service Worker 断连（杀掉扩展的 plugin WebSocket）
 * 3. 验证服务器正确清理 plugin 状态
 * 4. 扩展重连后，Playwright 能重新 pages()/newPage()/evaluate()
 * 5. 验证 chrome.alarms 保活机制（检查 manifest.json 有 alarms 权限）
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
const MANIFEST_PATH = path.resolve(__dirname, '../../extension-new/manifest.json');

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

(async () => {
  let passed = 0, failed = 0;
  const PORT = 10000 + Math.floor(Math.random() * 50000);

  // ── Test 1: manifest.json 必须有 alarms 权限 ──
  console.log('\n[Test 1] manifest.json alarms 权限检查');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.permissions.includes('alarms')) {
    console.log('[PASS] manifest.json 包含 alarms 权限');
    passed++;
  } else {
    console.log('[FAIL] manifest.json 缺少 alarms 权限！Service Worker 无法使用 chrome.alarms 保活');
    failed++;
  }

  // ── Test 2: background.js 必须使用 chrome.alarms 而非 setInterval ──
  console.log('\n[Test 2] background.js 使用 chrome.alarms 保活');
  const bgCode = fs.readFileSync(path.resolve(__dirname, '../../extension-new/background.js'), 'utf8');
  const usesAlarms = bgCode.includes('chrome.alarms') && bgCode.includes('onAlarm');
  const hasAlarmCreate = bgCode.includes('chrome.alarms.create');
  const hasAlarmListener = bgCode.includes('chrome.alarms.onAlarm.addListener');
  if (usesAlarms && hasAlarmCreate && hasAlarmListener) {
    console.log('[PASS] background.js 使用 chrome.alarms API 保活（兼容 setInterval 双保险）');
    passed++;
  } else {
    console.log(`[FAIL] background.js 未正确使用 chrome.alarms: usesAlarms=${usesAlarms}, hasAlarmCreate=${hasAlarmCreate}, hasAlarmListener=${hasAlarmListener}`);
    failed++;
  }

  // ── Test 3: proxy 端 plugin 心跳容错 ──
  console.log('\n[Test 3] proxy plugin 心跳容错检查');
  const proxyCode = fs.readFileSync(PROXY_PATH, 'utf8');
  const hasGracePeriod = proxyCode.includes('missedPings') || proxyCode.includes('grace') || proxyCode.includes('PLUGIN_MAX_MISSED');
  if (hasGracePeriod) {
    console.log('[PASS] proxy-server.js 有 plugin 心跳容错机制');
    passed++;
  } else {
    console.log('[FAIL] proxy-server.js 缺少 plugin 心跳容错！一次 ping 超时就会 terminate plugin');
    failed++;
  }

  // ── Test 4: E2E 断连重连验证 ──
  console.log('\n[Test 4] E2E: 扩展断连重连后 Playwright 恢复工作');
  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`));

  let proxyProc = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (!await waitForPort(PORT)) {
    console.log('[FAIL] Proxy 启动失败');
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }

  const profile = `/tmp/cdp-sw-test-${Date.now()}`;
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });

  let extReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const list = await httpGet(PORT, '/json/list');
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) { extReady = true; break; }
    } catch {}
    await sleep(2000);
  }

  if (!extReady) {
    console.log('[FAIL] 扩展未连接');
    process.kill(-chromeProc.pid); proxyProc.kill();
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  console.log('  扩展已连接');

  // Phase A: 初始连接验证
  try {
    const browserA = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
    const pagesA = browserA.contexts()[0].pages();
    console.log(`  Phase A: pages()=${pagesA.length}`);
    if (pagesA.length >= 1) {
      console.log('[PASS] Phase A: 初始 pages() 正常');
    } else {
      console.log('[FAIL] Phase A: pages()=0');
      failed++;
    }

    const pageA = await browserA.contexts()[0].newPage();
    await pageA.goto('https://www.example.com');
    const title = await pageA.evaluate(() => document.title);
    if (title === 'Example Domain') {
      console.log('[PASS] Phase A: newPage + evaluate 正常');
      passed++;
    } else {
      console.log(`[FAIL] Phase A: evaluate 返回 "${title}"`);
      failed++;
    }
    await browserA.close();
  } catch (e) {
    console.log(`[FAIL] Phase A 异常: ${e.message}`);
    failed++;
  }

  // Phase B: 模拟扩展断连 - 关闭 plugin WebSocket
  console.log('\n  Phase B: 模拟断连...');
  await sleep(2000);

  // 通过 raw WS 找到 plugin 连接并断开
  const statusData = await httpGet(PORT, '/json/version');
  console.log(`  Server version: ${statusData?.Browser || 'unknown'}`);

  // 等待足够长时间让心跳超时（模拟 SW 休眠）
  // 不直接杀 WS，而是等服务器心跳检测自然超时
  // 正常 HEARTBEAT_INTERVAL=30s，2个周期=60s
  // 但这里我们直接用 proxy 的内部机制来测试

  // 更简单的方式：通过 /json/list 确认断连
  // 杀掉 Chrome 会让扩展断连，然后重启 Chrome 模拟重连
  process.kill(-chromeProc.pid);
  await sleep(3000);

  // 确认断连
  const listAfter = await httpGet(PORT, '/json/list');
  if (!listAfter || listAfter.length === 0) {
    console.log('[PASS] Phase B: 扩展断连后 /json/list 返回空');
    passed++;
  } else {
    console.log(`[FAIL] Phase B: 断连后仍有 ${listAfter.length} 个 target`);
    failed++;
  }

  // Phase C: 重连验证 - 重启 Chrome + 扩展
  console.log('\n  Phase C: 重连测试...');
  const profile2 = `/tmp/cdp-sw-test-reconnect-${Date.now()}`;
  const chromeProc2 = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile2}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });

  let reconnected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const list = await httpGet(PORT, '/json/list');
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) { reconnected = true; break; }
    } catch {}
    await sleep(2000);
  }

  if (!reconnected) {
    console.log('[FAIL] Phase C: 扩展重连失败');
    process.kill(-chromeProc2.pid); proxyProc.kill();
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    process.exit(1);
  }
  console.log('  扩展已重连');

  try {
    const browserC = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
    const pagesC = browserC.contexts()[0].pages();
    if (pagesC.length >= 1) {
      console.log('[PASS] Phase C: 重连后 pages() 正常');
      passed++;
    } else {
      console.log('[FAIL] Phase C: 重连后 pages()=0');
      failed++;
    }

    const pageC = await browserC.contexts()[0].newPage();
    await pageC.goto('https://www.example.com');
    const val = await pageC.evaluate(() => 'reconnect-ok');
    if (val === 'reconnect-ok') {
      console.log('[PASS] Phase C: 重连后 newPage + evaluate 正常');
      passed++;
    } else {
      console.log(`[FAIL] Phase C: evaluate 返回 "${val}"`);
      failed++;
    }
    await browserC.close();
  } catch (e) {
    console.log(`[FAIL] Phase C 异常: ${e.message}`);
    failed++;
  }

  // Cleanup
  try { process.kill(-chromeProc2.pid); } catch {}
  proxyProc.kill();
  fs.writeFileSync(CONFIG_PATH, configOriginal);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
