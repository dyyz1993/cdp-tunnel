const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

let serverPort = 9600;

async function testWithLogs(label, port) {
  serverPort++;
  const currentPort = serverPort;
  
  console.log(`Testing ${label} (port ${port})`);
  
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
  
  const serverDir = '/tmp/test-logs3';
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
  
  console.log('\n=== STEP 1: Connecting to CDP Tunnel ===');
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  console.log('Connected! Now check extension logs for "client-connected" message');
  
  console.log('\n=== STEP 2: Waiting 3 seconds ===');
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('\n=== STEP 3: Creating context ===');
  const context = await browser.newContext();
  
  console.log('\n=== STEP 4: Creating first page ===');
  const page1 = await context.newPage();
  await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
  console.log(`Page loaded: ${page1.url()}`);
  
  console.log('\n=== STEP 5: Click the link NOW ===');
  console.log('>>> Check extension logs for: [WS] Client connected <<<');
  await page1.click('#link1');
  
  console.log('\n=== STEP 6: Waiting 5 seconds ===');
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('\n=== RESULTS ===');
  const allPages = context.pages();
  console.log(`Pages: ${allPages.length}`);
  
  server.close();
  await browser.close();
}

async function main() {
  console.log('=== Debug Test - Check "client-connected" message ===\n');
  console.log('INSTRUCTIONS:');
  console.log('1. Clear extension console logs');
  console.log('2. Run test');
  console.log('3. Look for: [WS] Client connected or client-connected');
  console.log('4. Tell me if you see it!\n');
  
  await testWithLogs('CDP Tunnel', 9221);
  
  process.exit(0);
}

main();
