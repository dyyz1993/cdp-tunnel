const { chromium } = require('playwright');
const { spawn } = require('child_process');

async function testRealScenario(port, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    console.log(`[${label}] Creating new context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] Testing addInitScript with counter...`);
    await context.addInitScript(() => {
      window.myInitScript = 'This is from addInitScript!';
      window.myCounter = (window.myCounter || 0) + 1;
      console.log('[InitScript] myCounter:', window.myCounter);
    });
    
    console.log(`[${label}] Creating first page and navigating to Baidu...`);
    const page1 = await context.newPage();
    await page1.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    console.log(`[${label}] Testing in Baidu page (counter should be 1)...`);
    const result1 = await page1.evaluate(() => {
      return { 
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] Baidu page result:`, result1);
    
    console.log(`[${label}] Searching for "test"...`);
    await page1.fill('#kw', 'test');
    await page1.click('#su');
    await page1.waitForSelector('#content_left', { timeout: 10000 });
    
    console.log(`[${label}] Clicking first search result (opens new tab)...`);
    const [page2] = await Promise.all([
      context.waitForEvent('page'),
      page1.click('#content_left a')
    ]);
    
    console.log(`[${label}] Waiting for new tab to load...`);
    await page2.waitForLoadState('domcontentloaded', { timeout: 15000 });
    console.log(`[${label}] New tab URL: ${page2.url()}`);
    
    console.log(`[${label}] Testing in new tab (counter should be 2 - incremented)...`);
    const result2 = await page2.evaluate(() => {
      return { 
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] New tab result:`, result2);
    
    console.log(`[${label}] Clicking another link in new tab...`);
    try {
      const links = await page2.locator('a').first();
      if (links) {
        const [page3] = await Promise.all([
          context.waitForEvent('page'),
          links.click()
        ]);
        
        console.log(`[${label}] Waiting for second new tab...`);
        await page3.waitForLoadState('domcontentloaded', { timeout: 15000 });
        console.log(`[${label}] Second new tab URL: ${page3.url()}`);
        
        console.log(`[${label}] Testing in second new tab (counter should be 3)...`);
        const result3 = await page3.evaluate(() => {
          return { 
            initScript: window.myInitScript,
            counter: window.myCounter
          };
        });
        console.log(`[${label}] Second new tab result:`, result3);
      }
    } catch (e) {
      console.log(`[${label}] No more links to click, skipping second new tab test`);
    }
    
    console.log(`[${label}] Switching back to first page (Baidu)...`);
    await page1.bringToFront();
    await page1.waitForLoadState('domcontentloaded');
    
    console.log(`[${label}] Testing in Baidu page again (counter should still be 1)...`);
    const result1Again = await page1.evaluate(() => {
      return { 
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] Baidu page (after switch) result:`, result1Again);
    
    const success = result1.counter === 1 && result2.counter === 2;
    
    if (success) {
      console.log(`[${label}] ✓ All tests passed!`);
    } else {
      console.log(`[${label}] ✗ Counter not incrementing correctly!`);
    }
    
    await browser.close();
    
    return success;
  } catch (error) {
    console.error(`[${label}] ✗ Error:`, error.message);
    console.error(`[${label}] Stack:`, error.stack);
    return false;
  }
}

async function main() {
  console.log('Testing real scenario: Baidu -> Search -> Click result -> New tab');
  console.log('Expected: Counter increments with each new page\n');
  
  console.log('Step 1: Starting fresh Chromium instance on port 9226...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9226',
    '--user-data-dir=/tmp/chromium-test-scenario',
    '--no-first-run',
    '--no-default-browser-check'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log('Waiting for Chromium to start...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testRealScenario(9226, 'Native CDP');
  
  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testRealScenario(9221, 'CDP Tunnel');
  
  console.log('\nStep 4: Cleaning up...');
  try {
    process.kill(-chromiumProcess.pid);
  } catch (e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9226): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel (port 9221): ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both implementations behave identically!');
    console.log('✓ addInitScript works correctly and counter increments across tabs!');
  } else if (nativeResult && !tunnelResult) {
    console.log('\n✗ CDP Tunnel has issues with addInitScript counter!');
  } else if (!nativeResult && tunnelResult) {
    console.log('\n? CDP Tunnel works but Native CDP has issues (unexpected)!');
  } else {
    console.log('\n✗ Both implementations have issues!');
  }
  
  process.exit(0);
}

main();
