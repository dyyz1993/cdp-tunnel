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
      <head><title>Page 1 - Baidu Like</title></head>
      <body>
        <h1>Baidu Search</h1>
        <input type="text" id="kw" placeholder="Search..." />
        <button id="su">Search</button>
        <div id="results">
          <a href="page2.html" target="_blank">Result 1</a>
          <a href="page3.html" target="_blank">Result 2</a>
        </div>
        <script>
          console.log('Page 1 loaded');
        </script>
      </body>
      </html>
    `;
    
    const htmlContent2 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 2 - Result</title></head>
      <body>
        <h1>Result Page 2</h1>
        <p>This is the result page.</p>
        <a href="page3.html" target="_blank">Go to Page 3</a>
      </body>
      </html>
    `;
    
    const htmlContent3 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 3 - Final</title></head>
      <body>
        <h1>Final Page 3</h1>
        <p>This is the final page.</p>
      </body>
      </html>
    `;
    
    const serverDir = '/tmp/test-pages';
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
    
    await new Promise(resolve => server.listen(8765, resolve));
    console.log(`[${label}] Test server started on port 8765`);
    
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
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto('http://localhost:8765/page1.html', { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Testing in first page (counter should be 1)...`);
    const result1 = await page1.evaluate(() => {
      return { 
        url: window.location.href,
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] First page result:`, result1);
    
    console.log(`[${label}] Clicking first link (opens new tab)...`);
    const [page2] = await Promise.all([
      context.waitForEvent('page'),
      page1.click('a:first-child')
    ]);
    
    console.log(`[${label}] Waiting for new tab to load...`);
    await page2.waitForLoadState('domcontentloaded');
    console.log(`[${label}] New tab URL: ${page2.url()}`);
    
    console.log(`[${label}] Testing in new tab (counter should be 2)...`);
    const result2 = await page2.evaluate(() => {
      return { 
        url: window.location.href,
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] Second page result:`, result2);
    
    console.log(`[${label}] Clicking another link in new tab...`);
    try {
      const [page3] = await Promise.all([
        context.waitForEvent('page'),
        page2.click('a:first-child')
      ]);
      
      console.log(`[${label}] Waiting for second new tab...`);
      await page3.waitForLoadState('domcontentloaded');
      console.log(`[${label}] Second new tab URL: ${page3.url()}`);
      
      console.log(`[${label}] Testing in second new tab (counter should be 3)...`);
      const result3 = await page3.evaluate(() => {
        return { 
          url: window.location.href,
          initScript: window.myInitScript,
          counter: window.myCounter
        };
      });
      console.log(`[${label}] Third page result:`, result3);
    } catch (e) {
      console.log(`[${label}] No more links to click`);
    }
    
    console.log(`[${label}] Switching back to first page...`);
    await page1.bringToFront();
    
    console.log(`[${label}] Testing in first page again (counter should still be 1)...`);
    const result1Again = await page1.evaluate(() => {
      return { 
        url: window.location.href,
        initScript: window.myInitScript,
        counter: window.myCounter
      };
    });
    console.log(`[${label}] First page (after switch) result:`, result1Again);
    
    const success = result1.counter === 1 && result2.counter === 2;
    
    server.close();
    
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
  console.log('Testing real scenario: Page1 -> Click link -> New tab -> Click link -> Another new tab');
  console.log('Expected: Counter increments with each new page (1 -> 2 -> 3)\n');
  
  console.log('Step 1: Starting fresh Chromium instance on port 9227...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9227',
    '--user-data-dir=/tmp/chromium-test-real',
    '--no-first-run',
    '--no-default-browser-check'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log('Waiting for Chromium to start...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testRealScenario(9227, 'Native CDP');
  
  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testRealScenario(9221, 'CDP Tunnel');
  
  console.log('\nStep 4: Cleaning up...');
  try {
    process.kill(-chromiumProcess.pid);
  } catch (e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9227): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
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
