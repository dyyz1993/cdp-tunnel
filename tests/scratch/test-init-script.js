const { chromium } = require('playwright');
const { spawn } = require('child_process');

async function testAddInitScript(port, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    console.log(`[${label}] Creating new context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] Testing addInitScript...`);
    await context.addInitScript(() => {
      window.myInitScript = 'This is from addInitScript!';
      window.myCounter = 0;
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto('about:blank', { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Testing in first page...`);
    const result1 = await page1.evaluate(() => {
      return { 
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] First page result:`, result1);
    
    console.log(`[${label}] Creating second page (simulating new tab)...`);
    const page2 = await context.newPage();
    await page2.goto('about:blank', { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Testing in second page (should persist)...`);
    const result2 = await page2.evaluate(() => {
      return { 
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] Second page result:`, result2);
    
    console.log(`[${label}] Creating third page...`);
    const page3 = await context.newPage();
    await page3.goto('about:blank', { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Testing in third page...`);
    const result3 = await page3.evaluate(() => {
      return { 
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] Third page result:`, result3);
    
    const success = result1.initScript && result2.initScript && result3.initScript;
    
    if (success) {
      console.log(`[${label}] ✓ All tests passed!`);
    } else {
      console.log(`[${label}] ✗ Some tests failed!`);
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
  console.log('Testing addInitScript persistence across tabs');
  console.log('This tests if addInitScript persists across different pages\n');
  
  console.log('Step 1: Starting fresh Chromium instance on port 9225...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9225',
    '--user-data-dir=/tmp/chromium-test-init',
    '--no-first-run',
    '--no-default-browser-check'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log('Waiting for Chromium to start...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testAddInitScript(9225, 'Native CDP');
  
  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testAddInitScript(9221, 'CDP Tunnel');
  
  console.log('\nStep 4: Cleaning up...');
  try {
    process.kill(-chromiumProcess.pid);
  } catch (e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9225): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel (port 9221): ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both implementations behave identically!');
    console.log('✓ addInitScript works correctly and persists across tabs!');
  } else if (nativeResult && !tunnelResult) {
    console.log('\n✗ CDP Tunnel has issues with addInitScript!');
  } else if (!nativeResult && tunnelResult) {
    console.log('\n? CDP Tunnel works but Native CDP has issues (unexpected)!');
  } else {
    console.log('\n✗ Both implementations have issues!');
  }
  
  process.exit(0);
}

main();
