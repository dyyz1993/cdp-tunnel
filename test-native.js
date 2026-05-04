const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

let serverPort = 10100;

async function test() {
  serverPort++;
  const currentPort = serverPort;
  
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
  
  const serverDir = '/tmp/test-wait';
  if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'page1.html'), htmlContent1);
  fs.writeFileSync(path.join(serverDir, 'page2.html'), htmlContent2);
  
  const server = http.createServer((req, res) => {
    let filePath = path.join(serverDir, req.url === '/' ? 'page1.html' : req.url);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  
  await new Promise(resolve => server.listen(currentPort, resolve));
  console.log(`Server: http://localhost:${currentPort}`);
  
  console.log('\n[TEST] Connecting to CDP Tunnel (port 9221)...');
  const browser = await chromium.connectOverCDP('http://localhost:9221');
  console.log('[TEST] Connected!');
  
  console.log('[TEST] Creating context...');
  const context = await browser.newContext();
  
  console.log('[TEST] Creating page...');
  const page1 = await context.newPage();
  await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
  console.log('[TEST] Page loaded');
  
  console.log('[TEST] Setting up page event listener...');
  let newPageReceived = false;
  context.on('page', (page) => {
    newPageReceived = true;
    console.log('[EVENT] New page created:', page.url());
  });
  
  console.log('[TEST] Clicking link and waiting for new page...');
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      page1.click('#link1')
    ]);
    console.log('[TEST] New page captured:', newPage.url());
  } catch (e) {
    console.log('[TEST] Timeout waiting for new page:', e.message);
  }
  
  console.log('\n[TEST] Checking pages...');
  const allPages = context.pages();
  console.log(`[TEST] Total pages: ${allPages.length}`);
  allPages.forEach((p, i) => {
    console.log(`  Page ${i}: ${p.url()}`);
  });
  
  console.log(`\n[TEST] New page event received: ${newPageReceived}`);
  console.log(`[TEST] RESULT: ${allPages.length >= 2 ? 'PASS' : 'FAIL'}`);
  
  server.close();
  await browser.close();
}

test().then(() => process.exit(0));
