const { chromium } = require('playwright');

async function testPlaywrightPages() {
  console.log('[Playwright Pages Test] Connecting to CDP proxy...');
  
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9221');
    console.log('[Playwright Pages Test] Connected successfully!');
    
    const contexts = browser.contexts();
    console.log(`[Playwright Pages Test] Found ${contexts.length} context(s)`);
    
    for (let i = 0; i < contexts.length; i++) {
      const context = contexts[i];
      console.log(`\n[Playwright Pages Test] Context ${i}:`);
      
      const pages = context.pages();
      console.log(`  Pages: ${pages.length}`);
      
      for (let j = 0; j < pages.length; j++) {
        const page = pages[j];
        console.log(`  Page ${j}: ${page.url()}`);
      }
    }
    
    console.log('\n[Playwright Pages Test] Trying to get all pages via CDP...');
    const client = await browser.newBrowserCDPSession();
    
    const result = await client.send('Target.getTargets');
    console.log(`[Playwright Pages Test] Found ${result.targetInfos.length} targets via CDP`);
    
    const pageTargets = result.targetInfos.filter(t => t.type === 'page');
    console.log(`[Playwright Pages Test] Found ${pageTargets.length} page targets`);
    
    pageTargets.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.url}`);
    });
    
    console.log('[Playwright Pages Test] Test completed!');
    await browser.close();
  } catch (error) {
    console.error('[Playwright Pages Test] Error:', error.message);
    console.error('[Playwright Pages Test] Stack:', error.stack);
  }
}

testPlaywrightPages();
