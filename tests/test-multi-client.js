const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTENSION_PATH = path.join(__dirname, '..', 'extension-new');
const CDP_PORT = 19321;
const TEST_EXT_DIR = '/tmp/cdp-tunnel-multi-test-ext';

const CHROME_PATH = fs.existsSync(CHROMIUM) ? CHROMIUM : fs.existsSync(CHROME) ? CHROME : null;
if (!CHROME_PATH) { console.error('Chrome not found'); process.exit(1); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
}

function wsSend(ws, msg) {
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      ws.off('message', handler);
      resolve(JSON.parse(data.toString()));
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
    setTimeout(() => { ws.off('message', handler); reject(new Error('response timeout')); }, 10000);
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('  多 Client / 多连接并发测试');
  console.log('='.repeat(60));

  // 1. Check server
  try {
    await httpGet(`http://localhost:${CDP_PORT}/json/version`);
    console.log('✓ CDP Tunnel 服务器正常');
  } catch {
    console.error('✗ CDP Tunnel 服务器未运行');
    process.exit(1);
  }

  // 2. Prepare extension
  if (fs.existsSync(TEST_EXT_DIR)) fs.rmSync(TEST_EXT_DIR, { recursive: true });
  fs.cpSync(EXTENSION_PATH, TEST_EXT_DIR, { recursive: true });
  const configPath = path.join(TEST_EXT_DIR, 'utils', 'config.js');
  let cfg = fs.readFileSync(configPath, 'utf-8');
  cfg = cfg.replace(/ws:\/\/localhost:\d+\/plugin/, `ws://localhost:${CDP_PORT}/plugin`);
  fs.writeFileSync(configPath, cfg);
  console.log('✓ 扩展已准备');

  // 3. Launch Chrome with extension
  const userDataDir = '/tmp/cdp-tunnel-multi-test-profile';
  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: CHROME_PATH,
    args: [
      `--disable-extensions-except=${TEST_EXT_DIR}`,
      `--load-extension=${TEST_EXT_DIR}`,
      '--no-first-run', '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  console.log('✓ Chrome 已启动');

  // Wait for extension
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const ver = JSON.parse(await httpGet(`http://localhost:${CDP_PORT}/json/version`));
      if (ver.webSocketDebuggerUrl) { console.log('✓ 扩展已连接\n'); break; }
    } catch {}
  }

  // ===== TEST 1: Multiple Client WS connections =====
  console.log('--- Test 1: 多 Client WebSocket 同时连接 ---');

  const verData = JSON.parse(await httpGet(`http://localhost:${CDP_PORT}/json/version`));
  const browserWsUrl = verData.webSocketDebuggerUrl;
  console.log('Browser WS: ' + browserWsUrl);

  const targetsData = JSON.parse(await httpGet(`http://localhost:${CDP_PORT}/json`));
  console.log('当前 targets: ' + targetsData.length);
  targetsData.forEach((t, i) => console.log(`  [${i}] ${t.url} -> ${t.webSocketDebuggerUrl}`));

  // Connect 3 clients
  const clients = [];
  for (let i = 0; i < 3; i++) {
    try {
      const ws = await wsConnect(browserWsUrl);
      clients.push({ ws, id: i });
      console.log(`  Client ${i + 1} 连接成功`);
    } catch (err) {
      console.log(`  Client ${i + 1} 连接失败: ${err.message}`);
    }
  }

  // Send commands from each client
  console.log('\n各 Client 发送命令测试:');
  for (const c of clients) {
    try {
      const resp = await wsSend(c.ws, { id: c.id * 100 + 1, method: 'Browser.getVersion' });
      console.log(`  Client ${c.id}: Browser.getVersion -> ${resp.result?.product || 'error: ' + (resp.error?.message || 'unknown')}`);
    } catch (err) {
      console.log(`  Client ${c.id}: 超时 - ${err.message}`);
    }
  }

  // ===== TEST 2: Multiple targets (pages) =====
  console.log('\n--- Test 2: 多 Target (多页面) 操作 ---');

  const page1 = context.pages()[0];
  await page1.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
  console.log('  Page 1: ' + page1.url());

  const page2 = await context.newPage();
  await page2.goto('https://httpbin.org/forms/post', { waitUntil: 'domcontentloaded', timeout: 10000 });
  console.log('  Page 2: ' + page2.url());

  const page3 = await context.newPage();
  await page3.goto('https://example.org', { waitUntil: 'domcontentloaded', timeout: 10000 });
  console.log('  Page 3: ' + page3.url());

  await sleep(2000);

  const targets2 = JSON.parse(await httpGet(`http://localhost:${CDP_PORT}/json`));
  console.log('\n  当前 targets: ' + targets2.length);
  targets2.forEach((t, i) => console.log(`    [${i}] ${t.url}`));

  // Check if pages got grouped
  console.log('\n--- Test 3: Chrome Tab Groups 检查 ---');
  const pageBefore = context.pages().length;
  console.log('  总页面数: ' + pageBefore);

  // ===== TEST 4: Concurrent commands from multiple clients =====
  console.log('\n--- Test 4: 并发命令测试 ---');

  const concurrentResults = await Promise.allSettled(
    clients.map(async (c) => {
      const responses = [];
      for (let j = 0; j < 5; j++) {
        try {
          const resp = await wsSend(c.ws, { id: c.id * 1000 + j, method: 'Target.getTargets' });
          responses.push({ client: c.id, cmd: j, targetCount: resp.result?.targetInfos?.length || 0 });
        } catch (err) {
          responses.push({ client: c.id, cmd: j, error: err.message });
        }
      }
      return responses;
    })
  );

  let concurrentOk = 0;
  let concurrentFail = 0;
  concurrentResults.forEach(r => {
    if (r.status === 'fulfilled') {
      r.value.forEach(v => {
        if (v.error) { concurrentFail++; console.log(`    Client ${v.client} cmd ${v.cmd}: FAIL - ${v.error}`); }
        else { concurrentOk++; }
      });
    } else {
      console.log(`    Client group failed: ${r.reason}`);
      concurrentFail += 5;
    }
  });
  console.log(`  成功: ${concurrentOk}, 失败: ${concurrentFail}`);

  // ===== TEST 5: Rapid connect/disconnect =====
  console.log('\n--- Test 5: 快速连接/断开循环 ---');

  let rapidOk = 0;
  let rapidFail = 0;
  for (let i = 0; i < 5; i++) {
    try {
      const ws = await wsConnect(browserWsUrl);
      const resp = await wsSend(ws, { id: i, method: 'Browser.getVersion' });
      ws.close();
      if (resp.result) rapidOk++;
      else rapidFail++;
    } catch {
      rapidFail++;
    }
    await sleep(200);
  }
  console.log(`  成功: ${rapidOk}/5, 失败: ${rapidFail}/5`);

  // ===== TEST 6: Check for blank pages after all operations =====
  console.log('\n--- Test 6: 检查空白页面 ---');

  const finalPages = context.pages();
  const blankPages = finalPages.filter(p => {
    const url = p.url();
    return url === 'about:blank' || url === '' || url === 'chrome://newtab/';
  });
  console.log(`  总页面: ${finalPages.length}, 空白页面: ${blankPages.length}`);
  finalPages.forEach((p, i) => {
    const url = p.url();
    const isBlank = url === 'about:blank' || url === '' || url === 'chrome://newtab/';
    console.log(`    [${i}] ${url}${isBlank ? ' ⚠空白!' : ''}`);
  });

  // Cleanup
  clients.forEach(c => c.ws.close());

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  测试结果汇总');
  console.log('='.repeat(60));
  console.log(`  多 Client 连接: ${clients.length}/3 成功`);
  console.log(`  并发命令: ${concurrentOk} 成功, ${concurrentFail} 失败`);
  console.log(`  快速连接/断开: ${rapidOk}/5`);
  console.log(`  空白页面: ${blankPages.length}`);

  const allOk = clients.length === 3 && concurrentFail === 0 && rapidFail === 0 && blankPages.length === 0;

  if (allOk) {
    console.log('\n  ✓ 所有测试通过');
  } else {
    console.log('\n  ✗ 部分测试失败，详见上方');
    if (blankPages.length > 0) console.log('  ⚠ 发现空白页面!');
    if (clients.length < 3) console.log('  ⚠ 部分 Client 连接失败');
    if (concurrentFail > 0) console.log('  ⚠ 并发命令有失败');
    if (rapidFail > 0) console.log('  ⚠ 快速连接/断开有失败');
  }

  await context.close();
  process.exit(allOk ? 0 : 1);
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
