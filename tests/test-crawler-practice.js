const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTENSION_PATH = path.join(__dirname, '..', 'extension-new');
const CDP_PORT = 19321;
const PRACTICE_BASE = 'http://localhost:3000';
const TEST_EXT_DIR = '/tmp/cdp-tunnel-complex-test-ext';

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

const TEST_PAGES = [
  { url: '/tools/crawler-practice/examples/18-iframe.html', name: 'iframe嵌套', wait: 5000 },
  { url: '/tools/crawler-practice/examples/21-shadow-dom.html', name: 'Shadow DOM', wait: 5000 },
  { url: '/tools/crawler-practice/examples/28-virtual-scroll.html', name: '虚拟滚动', wait: 5000 },
  { url: '/tools/crawler-practice/examples/29-fragment.html', name: 'DocumentFragment', wait: 5000 },
  { url: '/tools/crawler-practice/examples/20-complex.html', name: '综合反爬', wait: 5000 },
  { url: '/tools/crawler-practice/examples/31-ultimate.html', name: '终极挑战', wait: 8000 },
  { url: '/tools/crawler-practice/examples/22-portal-teleport.html', name: 'Portal/Teleport', wait: 5000 },
  { url: '/tools/crawler-practice/examples/24-social-media.html', name: '社交媒体', wait: 5000 },
  { url: '/tools/crawler-practice/examples/25-video-site.html', name: '视频网站', wait: 5000 },
  { url: '/tools/crawler-practice/examples/26-job-site.html', name: '招聘网站', wait: 5000 },
  { url: '/tools/crawler-practice/examples/27-house-site.html', name: '房产网站', wait: 5000 },
  { url: '/tools/crawler-practice/examples/32-ecommerce-admin.html', name: '电商卖家中心', wait: 5000 },
  { url: '/tools/crawler-practice/examples/33-government-bidding.html', name: '政府招标', wait: 5000 },
  { url: '/tools/crawler-practice/examples/34-secondhand-market.html', name: '二手交易', wait: 5000 },
  { url: '/tools/crawler-practice/examples/35-qa-community.html', name: '知识问答', wait: 5000 },
  { url: '/tools/crawler-practice/examples/36-stock-market.html', name: '证券行情', wait: 5000 },
  { url: '/tools/crawler-practice/examples/06-infinite-scroll.html', name: '无限滚动', wait: 5000 },
  { url: '/tools/crawler-practice/examples/07-lazy-load.html', name: '懒加载', wait: 5000 },
  { url: '/tools/crawler-practice/examples/19-dynamic-captcha.html', name: '动态验证码', wait: 5000 },
  { url: '/tools/crawler-practice/examples/23-css-in-js.html', name: 'CSS-in-JS', wait: 5000 },
];

async function main() {
  console.log('='.repeat(60));
  console.log('  CDP Tunnel - 爬虫练习场复杂页面测试');
  console.log('='.repeat(60));

  // 1. Check practice site
  try {
    await httpGet(PRACTICE_BASE + '/');
    console.log('✓ 爬虫练习场服务正常');
  } catch {
    console.error('✗ 爬虫练习场未运行，请先启动: cd apps/tool-box && npm run dev');
    process.exit(1);
  }

  // 2. Check CDP tunnel server
  try {
    const ver = JSON.parse(await httpGet(`http://localhost:${CDP_PORT}/json/version`));
    console.log('✓ CDP Tunnel 服务器正常: ' + CDP_PORT);
  } catch {
    console.error('✗ CDP Tunnel 服务器未运行');
    process.exit(1);
  }

  // 3. Prepare extension
  if (fs.existsSync(TEST_EXT_DIR)) fs.rmSync(TEST_EXT_DIR, { recursive: true });
  fs.cpSync(EXTENSION_PATH, TEST_EXT_DIR, { recursive: true });
  const configPath = path.join(TEST_EXT_DIR, 'utils', 'config.js');
  let cfg = fs.readFileSync(configPath, 'utf-8');
  cfg = cfg.replace(/ws:\/\/localhost:\d+\/plugin/, `ws://localhost:${CDP_PORT}/plugin`);
  fs.writeFileSync(configPath, cfg);
  console.log('✓ 扩展已准备 (端口 ' + CDP_PORT + ')');

  // 4. Launch Chrome
  const userDataDir = '/tmp/cdp-tunnel-complex-test-profile';
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

  // 5. Wait for extension
  console.log('等待扩展连接...');
  let extConnected = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const ver = JSON.parse(await httpGet(`http://localhost:${CDP_PORT}/json/version`));
      if (ver.webSocketDebuggerUrl) { extConnected = true; console.log('✓ 扩展已连接\n'); break; }
    } catch {}
    process.stdout.write('.');
  }
  if (!extConnected) { console.error('\n✗ 扩展未连接'); await context.close(); process.exit(1); }

  const page = context.pages()[0] || await context.newPage();

  // 6. Test each page
  let totalBlank = 0;
  let totalTested = 0;
  let totalNewPages = 0;
  const blankDetails = [];
  const failedPages = [];

  for (const tp of TEST_PAGES) {
    const fullUrl = PRACTICE_BASE + tp.url;
    const pageBefore = context.pages().length;

    try {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(tp.wait);

      const pagesAfter = context.pages();
      const newPages = pagesAfter.length - pageBefore;

      totalTested++;
      let status = '✓';
      let extra = '';

      if (newPages > 0) {
        totalNewPages += newPages;
        for (let i = pageBefore; i < pagesAfter.length; i++) {
          const newUrl = pagesAfter[i].url();
          const isBlank = newUrl === 'about:blank' || newUrl === '' || newUrl === 'chrome://newtab/';
          if (isBlank) {
            totalBlank++;
            status = '✗';
            blankDetails.push({ page: tp.name, url: fullUrl, blankUrl: newUrl });
          }
          extra += ` [新页面: "${newUrl}"${isBlank ? ' ⚠空白!' : ''}]`;
        }
      }

      console.log(`  ${status} [${totalTested}/${TEST_PAGES.length}] ${tp.name}${extra}`);
    } catch (err) {
      totalTested++;
      failedPages.push({ name: tp.name, error: err.message });
      console.log(`  ✗ [${totalTested}/${TEST_PAGES.length}] ${tp.name} - 加载失败: ${err.message.substring(0, 60)}`);
    }

    // Close any extra pages to keep clean state
    while (context.pages().length > 1) {
      const extraPage = context.pages()[context.pages().length - 1];
      if (extraPage !== page) await extraPage.close().catch(() => {});
      else break;
    }
  }

  // 7. Summary
  console.log('\n' + '='.repeat(60));
  console.log('  测试结果汇总');
  console.log('='.repeat(60));
  console.log(`  测试页面: ${totalTested}/${TEST_PAGES.length}`);
  console.log(`  加载失败: ${failedPages.length}`);
  console.log(`  新增页面: ${totalNewPages}`);
  console.log(`  空白页面: ${totalBlank}`);

  if (blankDetails.length > 0) {
    console.log('\n  ✗ 发现空白页面 BUG:');
    blankDetails.forEach(d => console.log(`    - ${d.page}: 访问 ${d.url} 时出现 ${d.blankUrl}`));
  }

  if (failedPages.length > 0) {
    console.log('\n  加载失败的页面:');
    failedPages.forEach(f => console.log(`    - ${f.name}: ${f.error.substring(0, 80)}`));
  }

  if (totalBlank === 0) {
    console.log('\n  ✓ 所有页面测试通过，没有出现空白页面');
  }

  await context.close();
  process.exit(totalBlank > 0 ? 1 : 0);
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
