const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let serverPort = 9300;

async function testWithDebugging(label, port) {
  serverPort++;
  const currentPort = serverPort;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} (port ${port})`);
  console.log('='.repeat(60));
  
  try {
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
    
    const serverDir = '/tmp/test-debug';
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
    
    console.log(`[${label}] Connecting to browser...`);
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    console.log(`[${label}] Connected!`);
    
    console.log(`[${label}] Getting all targets via CDP...`);
    const session = await browser.newBrowserCDPSession();
    const targets = await session.send('Target.getTargets');
    
    console.log(`[${label}] Current targets:`);
    const pageTargets = targets.targetInfos.filter(t => t.type === 'page');
    pageTargets.forEach(t => {
      console.log(`  - ${t.targetId}: ${t.url} (attached: ${t.attached})`);
    });
    
    console.log(`[${label}] Creating context...`);
    const context = await browser.newContext();
    
    console.log(`[${label}] Creating first page...`);
    const page1 = await context.newPage();
    await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
    
    await new Promise(r => setTimeout(r, 1000));
    
    console.log(`[${label}] Checking targets after creating first page...`);
    const targets2 = await session.send('Target.getTargets');
    const pageTargets2 = targets2.targetInfos.filter(t => t.type === 'page');
    pageTargets2.forEach(t => {
      console.log(`  - ${t.targetId}: ${t.url} (attached: ${t.attached})`);
    });
    
    console.log(`[${label}] Clicking link...`);
    await page1.click('#link1');
    
    console.log(`[${label}] Waiting 5 seconds...`);
    await new Promise(r => setTimeout(r, 5000));
    
    console.log(`[${label}] Checking targets after clicking link...`);
    const targets3 = await session.send('Target.getTargets');
    const pageTargets3 = targets3.targetInfos.filter(t => t.type === 'page');
    pageTargets3.forEach(t => {
      console.log(`  - ${t.targetId}: ${t.url} (attached: ${t.attached})`);
    });
    
    console.log(`[${label}] Checking context pages...`);
    const allPages = context.pages();
    console.log(`[${label}] Total pages in context: ${allPages.length}`);
    allPages.forEach((p, i) => {
      console.log(`  Page ${i}: ${p.url()}`);
    });
    
    server.close();
    await browser.close();
    
  } catch (error) {
    console.error(`[${label}] Error:`, error.message);
  }
}

async function main() {
  console.log('=== CDP Target Debugging Test ===\n');
  
  console.log('### Test with CDP Tunnel (port 9221) ###');
  await testWithDebugging('CDP Tunnel', 9221);
  
  process.exit(0);
}

main();
