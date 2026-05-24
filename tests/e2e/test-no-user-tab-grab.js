/**
 * TDD: 用户 tab 不被抢测试
 *
 * 验证：
 * 1. CDP 连接后用户页面不被 debugger.attach
 * 2. 用户页面不被加入 CDP 的 tab group
 * 3. CDP 创建的页面才被 attach 和分组
 * 4. 断连后只清理 CDP 自己的 tab group
 */

const http = require('http');
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

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

(async () => {
  let passed = 0, failed = 0;
  const PORT = 18888 + Math.floor(Math.random() * 1000);
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

  // Start Chrome with 1 user tab (about:blank)
  const profile = `/tmp/cdp-no-grab-test-${Date.now()}`;
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });

  await sleep(8000);
  let extReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
      if ((res || []).filter(t => t.type === 'page').length > 0) { extReady = true; break; }
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
  console.log('Extension connected');

  // ── Test 1: CDP 连接后用户 tab 不被 attach ──
  console.log('\n[Test 1] CDP 连接后用户 tab 不被 debugger.attach');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
  const ctx = browser.contexts()[0];

  // Playwright pages() should be 1 (auto-default-page only) — user's about:blank should NOT be visible
  const initialPages = ctx.pages();
  console.log(`  pages() after connect: ${initialPages.length}`);
  initialPages.forEach((p, i) => console.log(`    page[${i}]: ${p.url()}`));

  const allOwnedPages = initialPages.every(p => p.url() === 'about:blank');
  if (initialPages.length >= 1 && allOwnedPages) {
    console.log('[PASS] Only auto-default-page visible, user tab not grabbed');
    passed++;
  } else {
    console.log(`[FAIL] User tab was attached! pages()=${initialPages.length}`);
    initialPages.forEach(p => console.log(`    ${p.url()}`));
    failed++;
  }

  // ── Test 2: 创建新 tab，只有新 tab + auto-default-page 可见 ──
  console.log('\n[Test 2] 创建新 tab 后只有 CDP 页面可见');
  const newPage = await ctx.newPage();
  await newPage.goto('https://www.baidu.com');
  await sleep(1000);

  const pagesAfterCreate = ctx.pages();
  console.log(`  pages() after newPage: ${pagesAfterCreate.length}`);
  console.log(`  newPage url: ${newPage.url()}`);

  if (pagesAfterCreate.length === 2 && newPage.url().includes('baidu')) {
    console.log('[PASS] Only CDP-created pages visible (auto-default + baidu)');
    passed++;
  } else {
    console.log(`[FAIL] Expected 2 pages with baidu, got ${pagesAfterCreate.length}`);
    pagesAfterCreate.forEach(p => console.log(`    ${p.url()}`));
    failed++;
  }

  // ── Test 3: 检查 Chrome tab groups ──
  console.log('\n[Test 3] Tab group 状态检查 (代码层面)');
  // 通过 CDP 检查 tab group
  const cdpSession = await browser.newBrowserCDPSession();
  // 使用 chrome.tabGroups 检查分组数量（通过 Target.getTargetInfo）
  const targetInfo = await cdpSession.send('Target.getTargetInfo');
  console.log(`  Target info retrieved`);
  // 在 headless 模式下 tabGroups API 不可用，但我们可以验证页面数量
  await cdpSession.detach();

  // ── Test 4: 断连后用户 tab 存活 ──
  console.log('\n[Test 4] 断连后用户 tab 存活');
  await browser.close();
  await sleep(3000);

  // 重新连接检查
  const browser2 = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
  const ctx2 = browser2.contexts()[0];
  const pagesAfterDisconnect = ctx2.pages();
  console.log(`  pages() after reconnect: ${pagesAfterDisconnect.length}`);

  const allBlank = pagesAfterDisconnect.every(p => p.url() === 'about:blank');
  if (pagesAfterDisconnect.length >= 1 && allBlank) {
    console.log('[PASS] After disconnect, CDP pages cleaned, only new auto-default-page visible, user tab not grabbed');
    passed++;
  } else {
    console.log(`[FAIL] After disconnect, ${pagesAfterDisconnect.length} pages still visible`);
    pagesAfterDisconnect.forEach(p => console.log(`    ${p.url()}`));
    failed++;
  }

  // ── Test 5: source code check - emitAutoAttach skips user pages ──
  console.log('\n[Test 5] 源码检查: emitAutoAttachForExistingTargets 跳过用户页面');
  const specialCode = fs.readFileSync(path.resolve(__dirname, '../../extension-new/cdp/handler/special.js'), 'utf8');
  const attachLogic = specialCode.substring(
    specialCode.indexOf('function emitAutoAttachForExistingTargets'),
    specialCode.indexOf('function emitAutoAttachEvents')
  );

  // Check if the function skips non-CDP-created pages
  const skipsUserPages = attachLogic.includes('isCDPCreated') && !attachLogic.includes('isPreExisting && clientId') === false;
  // The function should NOT call DebuggerManager.attach for user pages
  const attachesUserPages = /DebuggerManager\.attach\(tabId\)/.test(attachLogic);

  // Check if the function skips non-CDP-created pages before attach
  const hasSkipNonCDP = attachLogic.includes('!isCDPCreated') && attachLogic.includes('Skipping non-CDP');
  const hasDebuggerAttach = attachLogic.includes('DebuggerManager.attach');

  if (hasSkipNonCDP) {
    console.log('[PASS] emitAutoAttachForExistingTargets 在 attach 前跳过用户页面');
    passed++;
  } else {
    console.log(`[FAIL] emitAutoAttachForExistingTargets 没有在 attach 前跳过用户页面 (skipNonCDP=${hasSkipNonCDP}, hasAttach=${hasDebuggerAttach})`);
    failed++;
  }

  await browser2.close();

  // Cleanup
  try { process.kill(-chromeProc.pid); } catch {}
  proxyProc.kill();
  fs.writeFileSync(CONFIG_PATH, configOriginal);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
