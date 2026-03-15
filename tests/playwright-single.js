const { chromium } = require('playwright');

const SERVER_URL = process.env.CDP_SERVER || 'http://localhost:9221';

async function main() {
  console.log(`[Playwright] Connecting to ${SERVER_URL}...`);
  
  const browser = await chromium.connectOverCDP(SERVER_URL);
  
  console.log('[Playwright] Connected!');
  
  const contexts = browser.contexts();
  console.log(`[Playwright] Found ${contexts.length} context(s)`);
  
  const pages = contexts[0]?.pages() || [];
  console.log(`[Playwright] Found ${pages.length} page(s)`);
  
  if (pages.length > 0) {
    const page = pages[0];
    console.log(`[Playwright] First page URL: ${page.url()}`);
    
    console.log('[Playwright] Scrolling...');
    await page.evaluate(() => window.scrollBy(0, 100));
    
    console.log('[Playwright] Taking screenshot...');
    await page.screenshot({ path: 'tests/screenshot-playwright.png' });
  }
  
  console.log('[Playwright] Creating new page...');
  const newPage = await contexts[0].newPage();
  await newPage.goto('https://www.baidu.com');
  console.log(`[Playwright] New page URL: ${newPage.url()}`);
  
  await newPage.waitForTimeout(2000);
  
  console.log('[Playwright] Done!');
  
  await browser.close();
}

main().catch(console.error);
