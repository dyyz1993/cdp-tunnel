const { chromium } = require('playwright');

async function testContextFeatures(port, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    const contexts = browser.contexts();
    console.log(`[${label}] Found ${contexts.length} context(s)`);
    
    let context;
    if (contexts.length === 0) {
      console.log(`[${label}] Creating new context...`);
      context = await browser.newContext();
    } else {
      context = contexts[0];
    }
    
    console.log(`[${label}] Testing exposeFunction...`);
    await context.exposeFunction('myCustomFunction', (arg) => {
      console.log(`[${label}] myCustomFunction called with:`, arg);
      return `Hello from ${label}: ${arg}`;
    });
    
    console.log(`[${label}] Testing addInitScript...`);
    await context.addInitScript(() => {
      window.myInitScript = 'This is from addInitScript!';
      console.log('Init script executed!');
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto('https://www.example.com');
    
    console.log(`[${label}] Testing in first page...`);
    const result1 = await page1.evaluate(async () => {
      const funcResult = await window.myCustomFunction('test1');
      const initResult = window.myInitScript;
      return { funcResult, initResult };
    });
    console.log(`[${label}] First page result:`, result1);
    
    console.log(`[${label}] Creating second page (new tab)...`);
    const page2 = await context.newPage();
    await page2.goto('https://www.example.com');
    
    console.log(`[${label}] Testing in second page (should persist)...`);
    const result2 = await page2.evaluate(async () => {
      const funcResult = await window.myCustomFunction('test2');
      const initResult = window.myInitScript;
      return { funcResult, initResult };
    });
    console.log(`[${label}] Second page result:`, result2);
    
    console.log(`[${label}] Switching back to first page...`);
    const result1Again = await page1.evaluate(async () => {
      const funcResult = await window.myCustomFunction('test1-again');
      const initResult = window.myInitScript;
      return { funcResult, initResult };
    });
    console.log(`[${label}] First page (after switch) result:`, result1Again);
    
    console.log(`[${label}] Creating third page...`);
    const page3 = await context.newPage();
    await page3.goto('https://www.example.com');
    
    console.log(`[${label}] Testing in third page...`);
    const result3 = await page3.evaluate(async () => {
      const funcResult = await window.myCustomFunction('test3');
      const initResult = window.myInitScript;
      return { funcResult, initResult };
    });
    console.log(`[${label}] Third page result:`, result3);
    
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
  console.log('This tests if exposeFunction and addInitScript persist across different tabs\n');
  
  const nativeResult = await testContextFeatures(9333, 'Native CDP');
  const tunnelResult = await testContextFeatures(9221, 'CDP Tunnel');
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9333): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel (port 9221): ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both implementations behave identically!');
  } else if (nativeResult && !tunnelResult) {
    console.log('\n✗ CDP Tunnel has issues with Context-level features!');
  } else {
    console.log('\n✗ Native CDP has issues (unexpected)!');
  }
}

main();
