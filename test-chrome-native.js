const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let serverPort = 9200;

async function testWithChrome(label) {
  serverPort++;
  const currentPort = serverPort;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${label} - Using local Google Chrome`);
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
    
    const serverDir = '/tmp/test-chrome-native';
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
    
    console.log(`[${label}] Launching Google Chrome...`);
    const browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: false
    });
    
    console.log(`[${label}] Launched!`);
    
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
    
    console.log(`[${label}] Waiting 3 seconds...`);
    await new Promise(r => setTimeout(r, 3000));
    
    console.log(`[${label}] Checking pages...`);
    const allPages = context.pages();
    console.log(`[${label}] Total pages: ${allPages.length}`);
    for (let i = 0; i < allPages.length; i++) {
      console.log(`[${label}] Page ${i}: ${allPages[i].url()}`);
    }
    
    if (allPages.length >= 2) {
      console.log(`[${label}] Testing new tab...`);
      const page2 = allPages[1];
      const r2 = await page2.evaluate(() => window.getCounter());
      console.log(`[${label}] New tab: ${r2}`);
      
      console.log(`[${label}] First page again...`);
      const r1a = await page1.evaluate(() => window.getCounter());
      console.log(`[${label}] First page again: ${r1a}`);
      
      console.log(`[${label}] New tab again...`);
      const r2a = await page2.evaluate(() => window.getCounter());
      console.log(`[${label}] New tab again: ${r2a}`);
      
      const success = r1 === 1 && r2 === 2 && r1a === 3 && r2a === 4;
      if (success) {
        console.log(`[${label}] ✓ PASS! Counter: 1 -> 2 -> 3 -> 4`);
      } else {
        console.log(`[${label}] ✗ FAIL! Expected: 1,2,3,4 Got: ${r1},${r2},${r1a},${r2a}`);
      }
    } else {
      console.log(`[${label}] ✗ No new tab found!`);
    }
    
    server.close();
    await browser.close();
    
  } catch (error) {
    console.error(`[${label}] Error:`, error.message);
    console.error(error.stack);
  }
}

async function main() {
  console.log('Testing with local Google Chrome\n');
  await testWithChrome('Native Chrome');
  process.exit(0);
}

main();
