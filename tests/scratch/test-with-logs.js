const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

let serverPort = 9400;

async function testWithLogs(label, port) {
  serverPort++;
  const currentPort = serverPort;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('Please check Chrome extension popup for logs');
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
  
  const serverDir = '/tmp/test-logs';
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
  console.log(`[${label}] Server: http://localhost:${currentPort}`);
  
  console.log(`\n[${label}] Step 1: Connecting to CDP Tunnel...`);
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  console.log(`[${label}] Connected!`);
  
  console.log(`\n[${label}] Step 2: Creating context...`);
  const context = await browser.newContext();
  
  console.log(`\n[${label}] Step 3: Creating first page...`);
  const page1 = await context.newPage();
  await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
  console.log(`[${label}] First page loaded: ${page1.url()}`);
  
  console.log(`\n[${label}] Step 4: Waiting 2 seconds...`);
  await new Promise(r => setTimeout(r, 2000));
  
  console.log(`\n[${label}] Step 5: Clicking link to open new tab...`);
  console.log(`[${label}] >>> PLEASE CHECK EXTENSION LOGS NOW <<<`);
  await page1.click('#link1');
  
  console.log(`\n[${label}] Step 6: Waiting 5 seconds for new tab...`);
  await new Promise(r => setTimeout(r, 5000));
  
  console.log(`\n[${label}] Step 7: Checking results...`);
  const allPages = context.pages();
  console.log(`[${label}] Total pages in context: ${allPages.length}`);
  allPages.forEach((p, i) => {
    console.log(`  Page ${i}: ${p.url()}`);
  });
  
  if (allPages.length >= 2) {
    console.log(`\n[${label}] ✓ SUCCESS! New tab was captured!`);
  } else {
    console.log(`\n[${label}] ✗ FAILED! New tab was NOT captured!`);
    console.log(`[${label}] Please check extension logs and copy them here.`);
  }
  
  server.close();
  await browser.close();
}

async function main() {
  console.log('=== Test with Log Monitoring ===');
  console.log('Instructions:');
  console.log('1. Open Chrome extension popup');
  console.log('2. Click "Inspect" or open DevTools for the popup');
  console.log('3. Watch the console logs');
  console.log('4. When the test runs, copy the logs here\n');
  
  await testWithLogs('CDP Tunnel', 9221);
  
  console.log('\n' + '='.repeat(60));
  console.log('Test completed!');
  console.log('Please share the extension logs if the test failed.');
  console.log('='.repeat(60));
  
  process.exit(0);
}

main();
