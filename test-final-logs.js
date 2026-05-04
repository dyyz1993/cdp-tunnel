const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

let serverPort = 9500;

async function testWithLogs(label, port) {
  serverPort++;
  const currentPort = serverPort;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  const htmlContent1 = `
    <!DOCTYPE html>
    <html>
    <head><title>Page 1</title></head>
    <body>
      <h1>Page 1 - Click the link below</h1>
      <a href="page2.html" target="_blank" id="link1">Open New Tab</a>
    </body>
    </html>
  `;
  
  const htmlContent2 = `
    <!DOCTYPE html>
    <html>
    <head><title>Page 2</title></head>
    <body>
      <h1>Page 2 - New Tab Opened!</h1>
    </body>
    </html>
  `;
  
  const serverDir = '/tmp/test-logs2';
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }
  fs.writeFileSync(path.join(serverDir, 'page1.html'), htmlContent1);
  fs.writeFileSync(path.join(serverDir, 'page2.html'), htmlContent2);
  
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
  console.log(`Server: http://localhost:${currentPort}/page1.html`);
  
  console.log('\nConnecting to CDP Tunnel...');
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  console.log('Connected!');
  
  console.log('Creating context...');
  const context = await browser.newContext();
  
  console.log('Creating first page...');
  const page1 = await context.newPage();
  await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
  console.log(`First page loaded: ${page1.url()}`);
  
  console.log('\n>>> CLICK THE LINK NOW - Check extension logs! <<<');
  console.log('>>> Look for: [Tabs] Tab created or Tab not controlled <<<\n');
  
  await page1.click('#link1');
  
  console.log('Waiting 10 seconds for you to check logs...');
  await new Promise(r => setTimeout(r, 10000));
  
  console.log('\nChecking results...');
  const allPages = context.pages();
  console.log(`Total pages in context: ${allPages.length}`);
  allPages.forEach((p, i) => {
    console.log(`  Page ${i}: ${p.url()}`);
  });
  
  if (allPages.length >= 2) {
    console.log('\n✓ SUCCESS!');
  } else {
    console.log('\n✗ FAILED - Please copy the extension logs now!');
    console.log('Look for: [Tabs] Tab created: or Tab not controlled:');
  }
  
  server.close();
  await browser.close();
}

async function main() {
  console.log('=== Test - Check Extension Logs ===\n');
  console.log('INSTRUCTIONS:');
  console.log('1. Make sure extension popup DevTools is open');
  console.log('2. When you see "CLICK THE LINK NOW", click the link in the page');
  console.log('3. Watch the extension logs for: [Tabs] Tab created');
  console.log('4. Copy those logs and paste them here\n');
  
  await testWithLogs('CDP Tunnel', 9221);
  
  process.exit(0);
}

main();
