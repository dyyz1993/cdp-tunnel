const { chromium } = require('playwright');

async function main() {
  console.log('[Playwright] Connecting to http://localhost:8080...');
  
  const browser = await chromium.connectOverCDP('http://localhost:8080');
  console.log('[Playwright] Connected!');
  
  const context = browser.contexts()[0];
  const pages = context?.pages() || [];
  console.log('[Playwright] Found', pages.length, 'page(s)');
  
  console.log('\n>>> 请现在打开配置页面查看状态:');
  console.log('>>> chrome-extension://bchclccgjmihieacfmaelkpfjlghhoph/config-page-preview.html');
  console.log('>>> 等待 10 秒...\n');
  
  await new Promise(r => setTimeout(r, 10000));
  
  console.log('[Playwright] Creating new page...');
  const page = await context.newPage();
  await page.goto('https://www.baidu.com');
  console.log('[Playwright] New page URL:', page.url());
  
  console.log('\n>>> 新页面已创建，请查看配置页面是否显示');
  console.log('>>> 等待 10 秒...\n');
  
  await new Promise(r => setTimeout(r, 10000));
  
  console.log('[Playwright] Scrolling...');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 100));
    await new Promise(r => setTimeout(r, 500));
    console.log('  Scrolled', i + 1);
  }
  
  console.log('\n>>> 滚动完成，请查看配置页面');
  console.log('>>> 等待 5 秒后关闭...\n');
  
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('[Playwright] Done!');
  await browser.close();
}

main().catch(console.error);
