const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTENSION_PATH = path.join(__dirname, '..', 'extension-new');
const PORT = 19321;
const TEST_EXT_DIR = '/tmp/cdp-tunnel-blank-test-ext';

const CHROME_PATH = fs.existsSync(CHROMIUM) ? CHROMIUM : fs.existsSync(CHROME) ? CHROME : null;

if (!CHROME_PATH) {
  console.error('Chrome/Chromium not found');
  process.exit(1);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getTargets() {
  try {
    const data = await httpGet(`http://localhost:${PORT}/json`);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  空白页面测试');
  console.log('='.repeat(60));

  // 1. Prepare extension with patched port
  if (fs.existsSync(TEST_EXT_DIR)) {
    fs.rmSync(TEST_EXT_DIR, { recursive: true });
  }
  fs.cpSync(EXTENSION_PATH, TEST_EXT_DIR, { recursive: true });

  const configPath = path.join(TEST_EXT_DIR, 'utils', 'config.js');
  let configContent = fs.readFileSync(configPath, 'utf-8');
  configContent = configContent.replace(/ws:\/\/localhost:\d+\/plugin/, `ws://localhost:${PORT}/plugin`);
  fs.writeFileSync(configPath, configContent);
  console.log('✓ 扩展端口已设置为 ' + PORT);

  // 2. Launch Chrome with extension
  const userDataDir = '/tmp/cdp-tunnel-blank-test-profile';
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: CHROME_PATH,
    args: [
      `--disable-extensions-except=${TEST_EXT_DIR}`,
      `--load-extension=${TEST_EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  console.log('✓ Chrome 已启动，扩展已加载');
  console.log('');

  // 3. Wait for extension to connect
  console.log('等待扩展连接...');
  let connected = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const data = await httpGet(`http://localhost:${PORT}/json/version`);
      const info = JSON.parse(data);
      if (info.webSocketDebuggerUrl) {
        connected = true;
        console.log(`✓ 扩展已连接`);
        break;
      }
    } catch {}
    process.stdout.write('.');
  }
  console.log('');

  if (!connected) {
    console.error('✗ 扩展未连接到服务器');
    await context.close();
    process.exit(1);
  }

  // 4. Record initial targets
  const initialTargets = await getTargets();
  const initialUrls = initialTargets.map(t => t.url);
  console.log('\n初始 targets:');
  initialUrls.forEach((url, i) => console.log(`  [${i}] ${url}`));

  // 5. Navigate to a real page
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  console.log('\n导航到 example.com...');
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
  console.log('✓ 页面已加载: ' + page.url());

  // 6. Monitor for new blank pages for 30 seconds
  console.log('\n监控 30 秒，观察是否出现空白页面...');
  console.log('-'.repeat(60));

  const initialPageCount = context.pages().length;
  console.log(`初始页面数: ${initialPageCount}`);

  let blankPagesFound = [];
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const currentPages = context.pages();
    const currentTargets = await getTargets();

    if (currentPages.length > initialPageCount + blankPagesFound.length) {
      const newPage = currentPages[currentPages.length - 1];
      const newUrl = newPage.url();
      const isBlank = newUrl === 'about:blank' || newUrl === '' || newUrl === 'chrome://newtab/';
      console.log(`[${i + 1}s] ⚠ 新页面出现: "${newUrl}" ${isBlank ? '(空白页!)' : ''}`);
      if (isBlank) {
        blankPagesFound.push({ second: i + 1, url: newUrl });
      }
    }

    if (i % 5 === 4) {
      console.log(`[${i + 1}s] 页面数: ${currentPages.length}, targets: ${currentTargets.length}`);
    }
  }

  console.log('-'.repeat(60));
  console.log('\n最终 targets:');
  const finalTargets = await getTargets();
  finalTargets.forEach((t, i) => console.log(`  [${i}] ${t.url}`));

  const finalPages = context.pages();
  console.log(`\n最终页面数: ${finalPages.length} (初始: ${initialPageCount})`);

  if (blankPagesFound.length > 0) {
    console.log('\n✗ 发现空白页面:');
    blankPagesFound.forEach(p => console.log(`  第 ${p.second} 秒: ${p.url}`));
    console.log('\n这是一个 BUG — 扩展不应自动创建空白页面');
  } else if (finalPages.length > initialPageCount) {
    console.log('\n⚠ 有新页面但不是空白页，需要人工确认');
  } else {
    console.log('\n✓ 没有出现空白页面，测试通过');
  }

  await context.close();
  process.exit(blankPagesFound.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
