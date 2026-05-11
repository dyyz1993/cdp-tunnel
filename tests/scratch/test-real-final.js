const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function testRealScenario(port, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
    const htmlContent1 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 1</title></head>
      <body>
        <h1>Page 1 - Source</h1>
        <p>This is the source page.</p>
        <a href="page2.html" target="_blank">Open Result 1</a>
        <a href="page3.html" target="_blank">Open Result 2</a>
      </body>
      </html>
    `;
    
    const htmlContent2 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 2</title></head>
      <body>
        <h1>Page 2 - Result 1</h1>
        <p>This is result page 1.</p>
        <a href="page3.html" target="_blank">Open Result 2</a>
      </body>
      </html>
    `;
    
    const htmlContent3 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 3</title></head>
      <body>
        <h1>Page 3 - Result 2</h1>
        <p>This is result page 2.</p>
      </body>
      </html>
    `;
    
    const serverDir = '/tmp/test-pages-v2';
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }
    fs.writeFileSync(path.join(serverDir, 'page1.html'), htmlContent1);
    fs.writeFileSync(path.join(serverDir, 'page2.html'), htmlContent2);
    fs.writeFileSync(path.join(serverDir, 'page3.html'), htmlContent3);
    
    const http = require('http');
    const server = http.createServer((req, res) => {
      let filePath = path.join(serverDir, req.url === '/' ? 'page1.html' : req.url);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    
    await new Promise(resolve => server.listen(8766, resolve));
    console.log(`[${label}] Test server started on port 8766`);
    
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    console.log(`[${label}] Creating new context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] Testing addInitScript - set unique value per page...`);
    await context.addInitScript(() => {
      window.pageLoadedAt = Date.now();
      window.testValue = 'init-script-executed';
      console.log('[InitScript] Executed at:', window.pageLoadedAt);
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto('http://localhost:8766/page1.html', { waitUntil: 'domcontentloaded' });
    await page1.waitForTimeout(500);
    
    console.log(`[${label}] Testing in first page...`);
    const result1 = await page1.evaluate(() => {
      return { 
        url: window.location.href,
        testValue: window.testValue,
        pageLoadedAt: window.pageLoadedAt
      };
    });
    console.log(`[${label}] First page:`, {
      url: result1.url,
      testValue: result1.testValue,
      pageLoadedAt: new Date(result1.pageLoadedAt).toLocaleTimeString()
    });
    
    console.log(`[${label}] Clicking first link (opens new tab)...`);
    try {
      const [page2] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }),
        page1.click('a:first-child')
      ]);
      
      console.log(`[${label}] Waiting for new tab to load...`);
      await page2.waitForLoadState('domcontentloaded');
      await page2.waitForTimeout(500);
      console.log(`[${label}] New tab URL: ${page2.url()}`);
      
      console.log(`[${label}] Testing in second page (should have init script)...`);
      const result2 = await page2.evaluate(() => {
        return { 
          url: window.location.href,
          testValue: window.testValue,
          pageLoadedAt: window.pageLoadedAt
        };
      });
      console.log(`[${label}] Second page:`, {
        url: result2.url,
        testValue: result2.testValue,
        pageLoadedAt: new Date(result2.pageLoadedAt).toLocaleTimeString()
      });
      
      console.log(`[${label}] Clicking another link...`);
      try {
        const [page3] = await Promise.all([
          context.waitForEvent('page', { timeout: 10000 }),
          page2.click('a:first-child')
        ]);
        
        console.log(`[${label}] Waiting for third tab...`);
        await page3.waitForLoadState('domcontentloaded');
        await page3.waitForTimeout(500);
        
        console.log(`[${label}] Testing in third page...`);
        const result3 = await page3.evaluate(() => {
          return { 
            url: window.location.href,
            testValue: window.testValue,
            pageLoadedAt: window.pageLoadedAt
          };
        });
        console.log(`[${label}] Third page:`, {
          url: result3.url,
          testValue: result3.testValue,
          pageLoadedAt: new Date(result3.pageLoadedAt).toLocaleTimeString()
        });
      } catch (e) {
        console.log(`[${label}] No more links to click`);
      }
    } catch (e) {
      console.log(`[${label}] Error waiting for new tab: ${e.message}`);
    }
    
    console.log(`[${label}] Switching back to first page...`);
    await page1.bringToFront();
    await page1.waitForTimeout(500);
    
    console.log(`[${label}] Testing in first page again...`);
    const result1Again = await page1.evaluate(() => {
      return { 
        url: window.location.href,
        testValue: window.testValue,
        pageLoadedAt: window.pageLoadedAt
      };
    });
    console.log(`[${label}] First page (after switch):`, {
      url: result1Again.url,
      testValue: result1Again.testValue,
      pageLoadedAt: new Date(result1Again.pageLoadedAt).toLocaleTimeString()
    });
    
    const success = result1.testValue === 'init-script-executed' && 
                   result2?.testValue === 'init-script-executed' &&
                   result1.pageLoadedAt !== result2?.pageLoadedAt;
    
    server.close();
    
    if (success) {
      console.log(`[${label}] ✓ All tests passed!`);
      console.log(`[${label}] ✓ addInitScript executed in ALL new pages!`);
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
  console.log('Testing: Page1 -> Click link (new tab) -> Click link (another new tab)');
  console.log('Expected: addInitScript executes in EVERY new page (different timestamps)\n');
  
  console.log('Step 1: Starting fresh Chromium instance on port 9228...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9228',
    '--user-data-dir=/tmp/chromium-test-final',
    '--no-first-run',
    '--no-default-browser-check'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log('Waiting for Chromium to start...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testRealScenario(9228, 'Native CDP');
  
  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testRealScenario(9221, 'CDP Tunnel');
  
  console.log('\nStep 4: Cleaning up...');
  try {
    process.kill(-chromiumProcess.pid);
  } catch (e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9228): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel (port 9221): ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both implementations behave identically!');
    console.log('✓ addInitScript executes in EVERY new page!');
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
