const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let serverPort = 8800;

async function testExposeFunctionNewTab(port, label) {
  serverPort++;
  const currentPort = serverPort;
  
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
        <h1>Page 1</h1>
        <a href="page2.html" target="_blank" id="link1">Open New Tab</a>
        <button id="btn" onclick="window.getCounter().then(r => alert('Counter: ' + r))">Get Counter</button>
      </body>
      </html>
    `;
    
    const htmlContent2 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 2</title></head>
      <body>
        <h1>Page 2 - New Tab</h1>
        <button id="btn" onclick="window.getCounter().then(r => alert('Counter: ' + r))">Get Counter</button>
      </body>
      </html>
    `;
    
    const serverDir = '/tmp/test-expose-newtab';
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
    
    await new Promise(resolve => server.listen(currentPort, resolve));
    console.log(`[${label}] Test server started on port ${currentPort}`);
    
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected successfully!`);
    
    console.log(`[${label}] Creating new context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] exposeFunction getCounter...`);
    await context.exposeFunction('getCounter', () => {
      sharedState.counter += 1;
      console.log(`[${label}] getCounter called, counter: ${sharedState.counter}`);
      return sharedState.counter;
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Calling getCounter in first page...`);
    const r1 = await page1.evaluate(() => window.getCounter());
    console.log(`[${label}] First page result: ${r1}`);
    
    console.log(`[${label}] Clicking link to open new tab...`);
    const [page2] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      page1.click('#link1')
    ]);
    
    console.log(`[${label}] Waiting for new tab...`);
    await page2.waitForLoadState('domcontentloaded');
    console.log(`[${label}] New tab URL: ${page2.url()}`);
    
    console.log(`[${label}] Calling getCounter in new tab...`);
    const r2 = await page2.evaluate(() => window.getCounter());
    console.log(`[${label}] New tab result: ${r2}`);
    
    console.log(`[${label}] First page again...`);
    const r1a = await page1.evaluate(() => window.getCounter());
    console.log(`[${label}] First page again result: ${r1a}`);
    
    console.log(`[${label}] New tab again...`);
    const r2a = await page2.evaluate(() => window.getCounter());
    console.log(`[${label}] New tab again result: ${r2a}`);
    
    const success = r1 === 1 && r2 === 2 && r1a === 3 && r2a === 4;
    
    server.close();
    
    if (success) {
      console.log(`[${label}] ✓ PASS! Counter: 1 -> 2 -> 3 -> 4`);
    } else {
      console.log(`[${label}] ✗ FAIL! Expected: 1,2,3,4 Got: ${r1},${r2},${r1a},${r2a}`);
    }
    
    await browser.close();
    return success;
    
  } catch (error) {
    console.error(`[${label}] ✗ Error:`, error.message);
    return false;
  }
}

async function main() {
  console.log('Testing: Click link -> New tab -> getCounter (shared state)');
  console.log('Expected: 1 -> 2 -> 3 -> 4\n');
  
  console.log('Step 1: Starting fresh Chromium on port 9230...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9230',
    '--user-data-dir=/tmp/chromium-test-newtab',
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' });
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testExposeFunctionNewTab(9230, 'Native CDP');
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testExposeFunctionNewTab(9221, 'CDP Tunnel');
  
  try { process.kill(-chromiumProcess.pid); } catch (e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log(`Native CDP: ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel: ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);
  
  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both work identically!');
  } else if (!nativeResult && tunnelResult) {
    console.log('\n✓ CDP Tunnel works! Native CDP has limitations.');
  }
  
  process.exit(0);
}

main();
