const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTENSION_PATH = path.join(__dirname, '..', 'extension-new');
const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'proxy-server.js');
const USER_DATA_DIR = '/tmp/cdp-tunnel-e2e-test';
const PROXY_PORT = 19221;
const CDP_URL = `http://localhost:${PROXY_PORT}`;
const TEST_EXT_DIR = '/tmp/cdp-tunnel-e2e-extension';

const CHROME_PATH = fs.existsSync(CHROMIUM) ? CHROMIUM : fs.existsSync(CHROME) ? CHROME : null;

if (!CHROME_PATH) {
  console.error('Chrome/Chromium not found');
  process.exit(1);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function waitForServer(port, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(`http://localhost:${port}/json/version`);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function waitForExtension(maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const data = await httpGet(`http://localhost:${PROXY_PORT}/json/version`);
      const info = JSON.parse(data);
      return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function runTest() {
  let serverProc = null;
  let chromeProc = null;
  let browser = null;
  let passed = 0;
  let failed = 0;

  console.log('='.repeat(60));
  console.log('  CDP Tunnel E2E Automated Test');
  console.log('='.repeat(60));
  console.log(`  Chrome: ${CHROME_PATH}`);
  console.log(`  Extension: ${EXTENSION_PATH}`);
  console.log(`  Proxy: ${CDP_URL}`);
  console.log('='.repeat(60));

  try {
    // 1. Cleanup
    console.log('\n[Setup] Cleaning up...');
    if (fs.existsSync(USER_DATA_DIR)) {
      fs.rmSync(USER_DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(TEST_EXT_DIR)) {
      fs.rmSync(TEST_EXT_DIR, { recursive: true });
    }

    // Kill any existing process on port
    const { execSync } = require('child_process');
    try { execSync(`lsof -ti :${PROXY_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    await sleep(500);

    // 2. Copy extension and patch WS port
    console.log('[Setup] Preparing test extension (port ' + PROXY_PORT + ')...');
    execSync(`cp -r "${EXTENSION_PATH}" "${TEST_EXT_DIR}"`, { stdio: 'ignore' });
    const configPath = path.join(TEST_EXT_DIR, 'utils', 'config.js');
    let configContent = fs.readFileSync(configPath, 'utf8');
    configContent = configContent.replace(
      /WS_URL:\s*'ws:\/\/localhost:\d+\/plugin'/,
      `WS_URL: 'ws://localhost:${PROXY_PORT}/plugin'`
    );
    fs.writeFileSync(configPath, configContent);

    // 2. Start proxy server
    console.log('[Setup] Starting proxy server...');
    serverProc = spawn('node', [SERVER_SCRIPT], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PROXY_PORT) }
    });
    serverProc.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg.includes('PLUGIN') || msg.includes('CLIENT') || msg.includes('IFRAME')) {
        console.log(`  [Server] ${msg.substring(0, 120)}`);
      }
    });
    serverProc.stderr.on('data', () => {});

    if (!(await waitForServer(PROXY_PORT))) {
      throw new Error('Proxy server failed to start');
    }
    console.log('[Setup] Proxy server started');

    // 3. Launch Chrome with extension
    console.log('[Setup] Launching Chrome with extension...');
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--load-extension=${TEST_EXT_DIR}`,
      '--enable-features=AutomationControlled',
      'about:blank'
    ], {
      detached: false,
      stdio: 'ignore'
    });

    console.log('[Setup] Waiting for extension to connect...');
    await sleep(5000);

    // 4. Connect Playwright
    console.log('[Setup] Connecting Playwright...');
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    console.log('[Setup] Connected!\n');

    const context = browser.contexts()[0];
    const pages = context.pages();
    let page = pages.find(p => p.url() === 'about:blank') || pages[0];
    if (!page) page = await context.newPage();

    // === TESTS ===

    // Test 1: Basic page navigation
    console.log('[Test 1] Basic page navigation...');
    try {
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
      const title = await page.title();
      console.log(`[Test 1] PASS - title: "${title}"`);
      passed++;
    } catch (e) {
      console.error(`[Test 1] FAIL - ${e.message}`);
      failed++;
    }

    // Test 2: Fill input on main page
    console.log('\n[Test 2] Fill input on main page...');
    try {
      await page.goto(`file://${path.join(__dirname, 'iframe-test-page.html')}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.fill('#main-input-1', 'E2E test');
      const val = await page.inputValue('#main-input-1');
      if (val === 'E2E test') {
        console.log(`[Test 2] PASS - value: "${val}"`);
        passed++;
      } else {
        console.error(`[Test 2] FAIL - expected "E2E test", got "${val}"`);
        failed++;
      }
    } catch (e) {
      console.error(`[Test 2] FAIL - ${e.message}`);
      failed++;
    }

    // Test 3: Same-origin iframe fill
    console.log('\n[Test 3] Same-origin iframe fill...');
    try {
      const frame = page.frameLocator('#same-origin-iframe');
      await frame.locator('#iframe-input-1').fill('iframe works', { timeout: 10000 });
      const val = await frame.locator('#iframe-input-1').inputValue({ timeout: 5000 });
      if (val === 'iframe works') {
        console.log(`[Test 3] PASS - value: "${val}"`);
        passed++;
      } else {
        console.error(`[Test 3] FAIL - expected "iframe works", got "${val}"`);
        failed++;
      }
    } catch (e) {
      console.error(`[Test 3] FAIL - ${e.message.substring(0, 100)}`);
      failed++;
    }

    // Test 4: Create new page
    console.log('\n[Test 4] Create new page...');
    try {
      const newPage = await context.newPage();
      await newPage.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
      const title = await newPage.title();
      await newPage.close();
      console.log(`[Test 4] PASS - new page title: "${title}"`);
      passed++;
    } catch (e) {
      console.error(`[Test 4] FAIL - ${e.message}`);
      failed++;
    }

    // Test 5: Page.getFrameTree
    console.log('\n[Test 5] CDP Page.getFrameTree...');
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const frameTree = await cdpSession.send('Page.getFrameTree');
      const mainFrame = frameTree.frameTree.frame;
      const childCount = frameTree.frameTree.childFrames?.length || 0;
      await cdpSession.detach();
      console.log(`[Test 5] PASS - main frame: ${mainFrame.id} children: ${childCount}`);
      passed++;
    } catch (e) {
      console.error(`[Test 5] FAIL - ${e.message}`);
      failed++;
    }

    // Test 6: Target.setAutoAttach event count
    console.log('\n[Test 6] Target.setAutoAttach events...');
    try {
      const cdpSession = await page.context().newCDPSession(page);
      let eventCount = 0;
      cdpSession.on('Target.attachedToTarget', () => eventCount++);
      await cdpSession.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
      await sleep(3000);
      await cdpSession.detach();
      console.log(`[Test 6] PASS - attachedToTarget events: ${eventCount}`);
      passed++;
    } catch (e) {
      console.error(`[Test 6] FAIL - ${e.message}`);
      failed++;
    }

    // Test 7: Douyin page (custom protocol blocking) - no disconnect
    console.log('\n[Test 7] Douyin custom protocol (no disconnect)...');
    try {
      await page.goto('https://www.douyin.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);
      // If we get here without disconnect, the test passes
      const url = page.url();
      if (url.includes('douyin')) {
        console.log(`[Test 7] PASS - page alive at ${url.substring(0, 50)}`);
        passed++;
      } else {
        console.error(`[Test 7] FAIL - unexpected URL: ${url}`);
        failed++;
      }
    } catch (e) {
      console.error(`[Test 7] FAIL (possible disconnect) - ${e.message.substring(0, 120)}`);
      failed++;
    }

  } catch (e) {
    console.error(`\n!!! FATAL: ${e.message}`);
    failed++;
  } finally {
    // Cleanup
    console.log('\n[Cleanup] Tearing down...');
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (chromeProc) {
      try { chromeProc.kill('SIGKILL'); } catch {}
    }
    if (serverProc) {
      try { serverProc.kill('SIGKILL'); } catch {}
    }
    // Kill any leftover processes on our port
    const { execSync } = require('child_process');
    try { execSync(`lsof -ti :${PROXY_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    try {
      if (fs.existsSync(USER_DATA_DIR)) {
        fs.rmSync(USER_DATA_DIR, { recursive: true });
      }
    } catch {}

    console.log('\n' + '='.repeat(60));
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    process.exit(failed > 0 ? 1 : 0);
  }
}

runTest();
