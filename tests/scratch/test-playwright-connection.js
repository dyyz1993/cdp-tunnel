const { chromium } = require('playwright');

async function testPlaywright() {
  console.log('[Playwright Test] Connecting to CDP proxy...');
  
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9221');
    console.log('[Playwright Test] Connected successfully!');
    
    const contexts = browser.contexts();
    console.log(`[Playwright Test] Found ${contexts.length} context(s)`);
    
    if (contexts.length > 0) {
      const context = contexts[0];
      const pages = context.pages();
      console.log(`[Playwright Test] Found ${pages.length} page(s) in first context`);
      
      if (pages.length > 0) {
        const page = pages[0];
        console.log(`[Playwright Test] First page URL: ${page.url()}`);
        
        console.log('[Playwright Test] Trying to navigate to a new page...');
        const newPage = await context.newPage();
        await newPage.goto('https://www.example.com');
        console.log(`[Playwright Test] New page URL: ${newPage.url()}`);
        
        await newPage.waitForTimeout(2000);
        
        console.log('[Playwright Test] Taking screenshot...');
        await newPage.screenshot({ path: 'test-screenshot.png' });
        console.log('[Playwright Test] Screenshot saved to test-screenshot.png');
        
        await newPage.close();
      }
    }
    
    console.log('[Playwright Test] Test completed successfully!');
    await browser.close();
  } catch (error) {
    console.error('[Playwright Test] Error:', error.message);
    console.error('[Playwright Test] Stack:', error.stack);
  }
}

testPlaywright();
