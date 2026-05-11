const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let serverPort = 9000;

async function testWithLaunchBrowser(port, label, useConnect) {
  serverPort++;
  const currentPort = serverPort;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label}`);
  console.log(`Mode: ${useConnect ? 'connectOverCDP' : 'launch'}`);
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
      </body>
      </html>
    `;
    
    const htmlContent2 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 2</title></head>
      <body>
        <h1>Page 2 - New Tab</h1>
      </body>
      </html>
    `;
    
    const serverDir = '/tmp/test-launch';
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
    console.log(`[${label}] Server on port ${currentPort}`);
    
    let browser;
    if (useConnect) {
      console.log(`[${label}] Connecting to existing browser on port ${port}...`);
      browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    } else {
      console.log(`[${label}] Launching new browser...`);
      browser = await chromium.launch({
        headless: false,
        args: [`--remote-debugging-port=${port}`]
      });
      await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log(`[${label}] Connected/Launched!`);
    
    console.log(`[${label}] Creating context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] exposeFunction getCounter...`);
    await context.exposeFunction('getCounter', () => {
      sharedState.counter += 1;
      console.log(`[${label}] getCounter: ${sharedState.counter}`);
      return sharedState.counter;
    });
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
    
    console.log(`[${label}] Testing first page...`);
    try {
      const r1 = await page1.evaluate(() => window.getCounter());
      console.log(`[${label}] First page: ${r1}`);
    } catch (e) {
      console.log(`[${label}] First page ERROR: ${e.message}`);
    }
    
    console.log(`[${label}] Clicking link...`);
    await page1.click('#link1');
    
    console.log(`[${label}] Waiting 3 seconds...`);
    await new Promise(r => setTimeout(r, 3000));
    
    console.log(`[${label}] Checking pages...`);
    const allPages = context.pages();
    console.log(`[${label}] Total pages: ${allPages.length}`);
    for (let i = 0; i < allPages.length; i++) {
      console.log(`[${label}] Page ${i}: ${allPages[i].url()}`);
    }
    
    server.close();
    await browser.close();
    
  } catch (error) {
    console.error(`[${label}] Error:`, error.message);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Test 1: Playwright launch() - should work perfectly');
  console.log('Test 2: connectOverCDP() - for comparison');
  console.log('='.repeat(60));
  
  console.log('\n### Test 1: chromium.launch() ###');
  await testWithLaunchBrowser(0, 'Launch', false);
  
  await new Promise(r => setTimeout(r, 2000));
  
  console.log('\n### Test 2: chromium.connectOverCDP() to fresh browser ###');
  const p = require('child_process').spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9240',
    '--user-data-dir=/tmp/chromium-connect-test',
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' });
  
  await new Promise(r => setTimeout(r, 3000));
  
  await testWithLaunchBrowser(9240, 'Connect', true);
  
  try { process.kill(-p.pid); } catch(e) {}
  
  process.exit(0);
}

main();
