const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let serverPort = 9050;

async function testThreePages(port, label) {
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
        <a href="page2.html" id="link1">Go to Page 2 (same tab)</a>
        <button id="btn" onclick="window.getCounter().then(r => document.getElementById('result').innerText = r)">Get Counter</button>
        <div id="result">-</div>
      </body>
      </html>
    `;

    const htmlContent2 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 2</title></head>
      <body>
        <h1>Page 2</h1>
        <a href="page3.html" target="_blank" id="link2">Open Page 3 (new tab)</a>
        <button id="btn" onclick="window.getCounter().then(r => document.getElementById('result').innerText = r)">Get Counter</button>
        <div id="result">-</div>
      </body>
      </html>
    `;

    const htmlContent3 = `
      <!DOCTYPE html>
      <html>
      <head><title>Page 3</title></head>
      <body>
        <h1>Page 3 - New Tab</h1>
        <button id="btn" onclick="window.getCounter().then(r => document.getElementById('result').innerText = r)">Get Counter</button>
        <div id="result">-</div>
      </body>
      </html>
    `;

    const serverDir = '/tmp/test-three-pages';
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }
    fs.writeFileSync(path.join(serverDir, 'page1.html'), htmlContent1);
    fs.writeFileSync(path.join(serverDir, 'page2.html'), htmlContent2);
    fs.writeFileSync(path.join(serverDir, 'page3.html'), htmlContent3);

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

    const context = await browser.newContext();
    console.log(`[${label}] Context created`);

    await context.exposeFunction('getCounter', () => {
      sharedState.counter += 1;
      console.log(`[${label}] getCounter called -> counter: ${sharedState.counter}`);
      return sharedState.counter;
    });
    console.log(`[${label}] exposeFunction registered`);

    const page1 = await context.newPage();
    await page1.goto(`http://localhost:${currentPort}/page1.html`, { waitUntil: 'domcontentloaded' });
    console.log(`[${label}] Page 1 loaded: ${page1.url()}`);

    const r1 = await page1.evaluate(() => window.getCounter());
    console.log(`[${label}] Page 1 counter: ${r1} (expect 1)`);

    console.log(`[${label}] --- Step 1: Click link in Page 1 -> navigate to Page 2 (same tab) ---`);
    await Promise.all([
      page1.waitForURL('**/page2.html'),
      page1.click('#link1')
    ]);
    console.log(`[${label}] Page 1 navigated to Page 2: ${page1.url()}`);

    const r2 = await page1.evaluate(() => window.getCounter());
    console.log(`[${label}] Page 2 counter: ${r2} (expect 2)`);

    console.log(`[${label}] --- Step 2: Click link in Page 2 -> open Page 3 (new tab) ---`);
    const [page3] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      page1.click('#link2')
    ]);
    await page3.waitForLoadState('domcontentloaded');
    console.log(`[${label}] Page 3 opened in new tab: ${page3.url()}`);

    const r3 = await page3.evaluate(() => window.getCounter());
    console.log(`[${label}] Page 3 counter: ${r3} (expect 3)`);

    console.log(`[${label}] --- Step 3: Verify all pages ---`);
    const allPages = context.pages();
    console.log(`[${label}] Total pages in context: ${allPages.length} (expect 2)`);

    const r2again = await page1.evaluate(() => window.getCounter());
    console.log(`[${label}] Page 2 counter again: ${r2again} (expect 4)`);

    const r3again = await page3.evaluate(() => window.getCounter());
    console.log(`[${label}] Page 3 counter again: ${r3again} (expect 5)`);

    const success = r1 === 1 && r2 === 2 && r3 === 3 && r2again === 4 && r3again === 5;

    server.close();

    if (success) {
      console.log(`[${label}] ✓ PASS! Counter: ${r1} -> ${r2} -> ${r3} -> ${r2again} -> ${r3again}`);
    } else {
      console.log(`[${label}] ✗ FAIL! Expected: 1,2,3,4,5 Got: ${r1},${r2},${r3},${r2again},${r3again}`);
    }

    await browser.close();
    return success;

  } catch (error) {
    console.error(`[${label}] ✗ Error:`, error.message);
    return false;
  }
}

async function main() {
  console.log('Testing: Page1 -> navigate to Page2 (same tab) -> open Page3 (new tab)');
  console.log('Counter: 1 -> 2 -> 3 -> 4 -> 5 (shared state via exposeFunction)\n');

  console.log('Step 1: Starting Chromium on port 9230...');
  const chromiumProcess = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9230',
    '--user-data-dir=/tmp/chromium-test-three',
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' });

  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('\nStep 2: Testing Native CDP...');
  const nativeResult = await testThreePages(9230, 'Native CDP');

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('\nStep 3: Testing CDP Tunnel...');
  const tunnelResult = await testThreePages(9221, 'CDP Tunnel');

  try { process.kill(-chromiumProcess.pid); } catch (e) {}

  console.log('\n' + '='.repeat(60));
  console.log(`Native CDP:  ${nativeResult ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`CDP Tunnel:  ${tunnelResult ? '✓ PASS' : '✗ FAIL'}`);

  if (nativeResult && tunnelResult) {
    console.log('\n✓ Both work identically!');
  } else if (!nativeResult && tunnelResult) {
    console.log('\n✓ CDP Tunnel works! Native CDP has limitations.');
  } else if (nativeResult && !tunnelResult) {
    console.log('\n✗ CDP Tunnel has issues!');
  } else {
    console.log('\n✗ Both have issues!');
  }

  process.exit(0);
}

main();
