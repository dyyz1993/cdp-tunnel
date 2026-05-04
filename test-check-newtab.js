const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let serverPort = 8900;

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
    
    const serverDir = '/tmp/test-expose-newtab2';
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
    console.log(`[${label}] Test server on port ${currentPort}`);
    
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected!`);
    
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
    const r1 = await page1.evaluate(() => window.getCounter());
    console.log(`[${label}] First page: ${r1}`);
    
    console.log(`[${label}] Clicking link...`);
    await page1.click('#link1');
    
    console.log(`[${label}] Waiting 3 seconds for new tab...`);
    await new Promise(r => setTimeout(r, 3000));
    
    console.log(`[${label}] Checking pages in context...`);
    const allPages = context.pages();
    console.log(`[${label}] Total pages: ${allPages.length}`);
    for (let i = 0; i < allPages.length; i++) {
      const p = allPages[i];
      console.log(`[${label}] Page ${i}: ${p.url()}`);
    }
    
    if (allPages.length >= 2) {
      const page2 = allPages[1];
      console.log(`[${label}] Testing new tab...`);
      try {
        const r2 = await page2.evaluate(() => window.getCounter());
        console.log(`[${label}] New tab: ${r2}`);
      } catch (e) {
        console.log(`[${label}] New tab error: ${e.message}`);
      }
    } else {
      console.log(`[${label}] No new tab found!`);
    }
    
    server.close();
    await browser.close();
    
  } catch (error) {
    console.error(`[${label}] Error:`, error.message);
  }
}

async function main() {
  console.log('Testing: Click link -> Check if new tab appears\n');
  
  console.log('Step 1: Native CDP...');
  const p1 = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9231',
    '--user-data-dir=/tmp/chromium-test-nt1',
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 3000));
  
  await testExposeFunctionNewTab(9231, 'Native CDP');
  
  await new Promise(r => setTimeout(r, 1000));
  try { process.kill(-p1.pid); } catch(e) {}
  
  console.log('\n' + '='.repeat(60));
  console.log('Step 2: CDP Tunnel...');
  
  await testExposeFunctionNewTab(9221, 'CDP Tunnel');
  
  process.exit(0);
}

main();
