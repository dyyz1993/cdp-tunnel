const { chromium } = require('playwright');

async function testContextFeaturesProper(port, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    console.log(`[${label}] Creating new context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] Testing exposeFunction...`);
    await context.exposeFunction('myCustomFunction', (arg) => {
      console.log(`[${label}] myCustomFunction called with:`, arg);
      return `Hello from ${label}: ${arg}`;
    });
    
    console.log(`[${label}] Testing addInitScript...`);
    await context.addInitScript(() => {
      window.myInitScript = 'This is from addInitScript!';
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto('about:blank');
    
    console.log(`[${label}] Testing in first page...`);
    const result1 = await page1.evaluate(async () => {
      try {
        const funcResult = await window.myCustomFunction('page1');
        const initResult = window.myInitScript;
        return { success: true, funcResult, initResult };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
    console.log(`[${label}] First page result:`, result1);
    
    if (!result1.success) {
      console.log(`[${label}] ✗ First page test failed!`);
      await browser.close();
      return false;
    }
    
    console.log(`[${label}] Creating second page (simulating new tab)...`);
    const page2 = await context.newPage();
    await page2.goto('about:blank');
    
    console.log(`[${label}] Testing in second page (should persist)...`);
    const result2 = await page2.evaluate(async () => {
      try {
        const funcResult = await window.myCustomFunction('page2');
        const initResult = window.myInitScript;
        return { success: true, funcResult, initResult };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
    console.log(`[${label}] Second page result:`, result2);
    
    if (!result2.success) {
      console.log(`[${label}] ✗ Second page test failed - Context features not persisted!`);
      await browser.close();
      return false;
    }
    
    console.log(`[${label}] Creating third page...`);
    const page3 = await context.newPage();
    await page3.goto('about:blank');
    
    console.log(`[${label}] Testing in third page...`);
    const result3 = await page3.evaluate(async () => {
      try {
        const funcResult = await window.myCustomFunction('page3');
        const initResult = window.myInitScript;
        return { success: true, funcResult, initResult };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
    console.log(`[${label}] Third page result:`, result3);
    
    if (!result3.success) {
      console.log(`[${label}] ✗ Third page test failed!`);
      await browser.close();
      return false;
    }
    
    console.log(`[${label}] ✓ All tests passed!`);
    
    await browser.close();
    
    return true;
  } catch (error) {
    console.error(`[${label}] ✗ Error:`, error.message);
    console.error(`[${label}] Stack:`, error.stack);
    return false;
  }
}

async function main() {
  console.log('Testing Context-level features persistence across tabs');
  console.log('This tests if exposeFunction and addInitScript persist across different pages\n');
  
  const nativeResult = await testContextFeaturesProper(9333, 'Native CDP');
  const tunnelResult = await testContextFeaturesProper(9221, 'CDP Tunnel');
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9333): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel (port 9221): ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both implementations behave identically!');
    console.log('✓ Context-level features (exposeFunction/addInitScript) work correctly!');
  } else if (nativeResult && !tunnelResult) {
    console.log('\n✗ CDP Tunnel has issues with Context-level features!');
  } else if (!nativeResult && tunnelResult) {
    console.log('\n? CDP Tunnel works but Native CDP has issues (unexpected)!');
  } else {
    console.log('\n✗ Both implementations have issues!');
  }
}

main();
