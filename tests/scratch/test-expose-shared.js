const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function testExposeFunctionSharedState(port, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
    const sharedState = { counter: 0 };
    
    const htmlContent1 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 1</title></head>
      <body>
        <h1>Page 1 - Source</h1>
        <button onclick="window.getAndIncrementCounter().then(r => document.getElementById('result').innerText = r)">
          Get Counter
        </button>
        <div id="result">Click button to get counter</div>
        <a href="page2.html" target="_blank">Open New Tab</a>
      </body>
      </html>
    `;
    
    const htmlContent2 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 2</title></head>
      <body>
        <h1>Page 2 - New Tab</h1>
        <button onclick="window.getAndIncrementCounter().then(r => document.getElementById('result').innerText = r)">
          Get Counter
        </button>
        <div id="result">Click button to get counter</div>
      </body>
      </html>
    `;
    
    const serverDir = '/tmp/test-expose';
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }
    fs.writeFileSync(path.join(serverDir, 'page1.html'), htmlContent1);
    fs.writeFileSync(path.join(serverDir, 'page2.html'), htmlContent2);
    
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
    
    await new Promise(resolve => server.listen(8767, resolve));
    console.log(`[${label}] Test server started on port 8767`);
    
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    console.log(`[${label}] Creating new context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] Testing exposeFunction (shared counter)...`);
    await context.exposeFunction('getAndIncrementCounter', () => {
      sharedState.counter += 1;
      console.log(`[${label}] getAndIncrementCounter called, counter: ${sharedState.counter}`);
      return sharedState.counter;
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto('http://localhost:8767/page1.html', { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Calling getAndIncrementCounter in first page...`);
    const result1 = await page1.evaluate(() => window.getAndIncrementCounter());
    console.log(`[${label}] First page counter:`, result1);
    
    console.log(`[${label}] Clicking link to open new tab...`);
    try {
      const [page2] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }),
        page1.click('a:first-child')
      ]);
      
      console.log(`[${label}] Waiting for new tab to load...`);
      await page2.waitForLoadState('domcontentloaded');
      console.log(`[${label}] New tab URL: ${page2.url()}`);
      
      console.log(`[${label}] Calling getAndIncrementCounter in new tab...`);
      const result2 = await page2.evaluate(() => window.getAndIncrementCounter());
      console.log(`[${label}] New tab counter:`, result2);
      
      console.log(`[${label}] Switching back to first page and calling again...`);
      await page1.bringToFront();
      const result1Again = await page1.evaluate(() => window.getAndIncrementCounter());
      console.log(`[${label}] First page counter (after switch):`, result1Again);
      
      console.log(`[${label}] Calling in new tab again...`);
      const result2Again = await page2.evaluate(() => window.getAndIncrementCounter());
      console.log(`[${label}] New tab counter (again):`, result2Again);
      
      const success = result1 === 1 && result2 === 2 && result1Again === 3 && result2Again === 4;
      
      server.close();
      
      if (success) {
        console.log(`[${label}] ✓ All tests passed!`);
        console.log(`[${label}] ✓ exposeFunction shared state works across tabs!`);
      } else {
        console.log(`[${label}] ✗ Counter values incorrect!`);
        console.log(`[${label}] Expected: 1, 2, 3, 4 | Got: ${result1}, ${result2}, ${result1Again}, ${result2Again}`);
      }
      
      await browser.close();
      return success;
      
    } catch (e) {
      console.log(`[${label}] Error: ${e.message}`);
      server.close();
      await browser.close();
      return false;
    }
    
  } catch (error) {
    console.error(`[${label}] ✗ Error:`, error.message);
    console.error(`[${label}] Stack:`, error.stack);
    return false;
  }
}

async function main() {
  console.log('Testing: exposeFunction shared state across tabs');
  console.log('Expected: Counter increments across ALL pages (1 -> 2 -> 3 -> 4)\n');
  
  console.log('Step 1: Starting fresh Chromium instance on port 9229...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9229',
    '--user-data-dir=/tmp/chromium-test-expose',
    '--no-first-run',
    '--no-default-browser-check'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  
  console.log('Waiting for Chromium to start...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testExposeFunctionSharedState(9229, 'Native CDP');
  
  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testExposeFunctionSharedState(9221, 'CDP Tunnel');
  
  console.log('\nStep 4: Cleaning up...');
  try {
    process.kill(-chromiumProcess.pid);
  } catch (e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(60));
  console.log(`Native CDP (port 9229): ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel (port 9221): ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both implementations behave identically!');
    console.log('✓ exposeFunction shared state works across tabs!');
  } else if (nativeResult && !tunnelResult) {
    console.log('\n✗ CDP Tunnel has issues with exposeFunction shared state!');
  } else if (!nativeResult && tunnelResult) {
    console.log('\n? CDP Tunnel works but Native CDP has issues (unexpected)!');
  } else {
    console.log('\n✗ Both implementations have issues!');
  }
  
  process.exit(0);
}

main();
