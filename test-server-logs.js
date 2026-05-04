const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

let serverPort = 9700;

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
  
  const serverDir = '/tmp/test-server-logs';
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
  
  console.log('\n=== Connecting to CDP Tunnel ===');
  console.log('>>> Check proxy server console for "[CLIENT CONNECTED]" <<<\n');
  
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  console.log('Connected!');
  
  console.log('\n=== Creating context and page ===');
  const context = await browser.newContext();
  const page1 = await context.newPage();
  await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
  console.log(`Page loaded: ${page1.url()}`);
  
  console.log('\n=== Waiting 5 seconds - check if client disconnects ===');
  console.log('>>> Check proxy server console for "[CLIENT DISCONNECTED]" <<<\n');
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('\n=== Clicking link ===');
  await page1.click('#link1');
  
  console.log('\n=== Waiting 5 more seconds ===');
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('\n=== Checking pages ===');
  const allPages = context.pages();
  console.log(`Pages: ${allPages.length}`);
  
  server.close();
  await browser.close();
}

async function main() {
  console.log('=== Test - Check Proxy Server Logs ===\n');
  console.log('INSTRUCTIONS:');
  console.log('1. Check proxy server console (where you ran npm start)');
  console.log('2. Look for: [CLIENT CONNECTED] and [CLIENT DISCONNECTED]');
  console.log('3. Tell me when the client disconnects!\n');
  
  await testWithLogs('CDP Tunnel', 9221);
  
  process.exit(0);
}

main();
