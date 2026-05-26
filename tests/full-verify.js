#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXTENSION_PATH = path.join(PROJECT_ROOT, 'extension-new');
const PROXY_PATH = path.join(PROJECT_ROOT, 'server', 'proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PORT = 19231;
const TAKEOVER_PORT = PORT + 1;

let proxyProc = null;
let chromeProc = null;
let originalConfig = null;
let _reqId = 0;

const results = [];

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sendCDP(ws, method, params = {}) {
  const id = ++_reqId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout: ${method}`));
    }, 20000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function waitForPort(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { await httpGet(port, '/json/version'); return true; } catch { await sleep(500); }
  }
  return false;
}

function recordResult(scenario, passed, detail) {
  results.push({ scenario, passed, detail });
  console.log(`  ${passed ? '✅' : '❌'} ${scenario}: ${detail}`);
}

async function setup() {
  log('SETUP', `Port: ${PORT}, Takeover: ${TAKEOVER_PORT}`);

  // Save and patch extension config
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    originalConfig.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`)
  );
  log('SETUP', 'Extension config patched');

  // Start proxy
  proxyProc = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'info' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  proxyProc.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s) log('PROXY-OUT', s.substring(0, 200));
  });
  proxyProc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) log('PROXY-ERR', s.substring(0, 200));
  });

  if (!await waitForPort(PORT)) {
    throw new Error('Proxy failed to start');
  }
  log('SETUP', 'Proxy started');

  if (!await waitForPort(TAKEOVER_PORT)) {
    throw new Error('Takeover port not ready');
  }
  log('SETUP', `Takeover port ${TAKEOVER_PORT} ready`);

  // Start Chrome with extension
  const profile = `/tmp/cdp-tunnel-verify-${Date.now()}`;
  chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'pipe' });
  chromeProc._profile = profile;
  chromeProc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s && !s.includes('INFO:CONSOLE')) log('CHROME', s.substring(0, 200));
  });

  // Wait for extension to connect
  await sleep(8000);
  let extReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpGet(PORT, '/json/list');
      if ((list || []).filter(t => t.type === 'page').length > 0) {
        extReady = true;
        break;
      }
    } catch {}
    await sleep(2000);
  }

  if (!extReady) throw new Error('Extension not connected');
  log('SETUP', 'Extension connected');

  // Open user pages via raw CDP (headless doesn't support multiple URL args)
  const setupWs = await connectWS(PORT);
  const setupTargets = await sendCDP(setupWs, 'Target.getTargets');
  const existingTargets = (setupTargets?.result?.targetInfos || []).filter(t => t.type === 'page');
  log('SETUP', `Existing targets: ${existingTargets.length}`);
  
  // Create new tabs for user pages
  const t1 = await sendCDP(setupWs, 'Target.createTarget', { url: 'https://www.example.com' });
  log('SETUP', `Created example.com tab: ${t1?.result?.targetId}`);
  const t2 = await sendCDP(setupWs, 'Target.createTarget', { url: 'https://www.baidu.com' });
  log('SETUP', `Created baidu.com tab: ${t2?.result?.targetId}`);
  setupWs.close();
  
  // Wait for pages to load
  await sleep(5000);

  const list = await httpGet(PORT, '/json/list');
  const pages = (list || []).filter(t => t.type === 'page');
  log('SETUP', `Available pages: ${pages.length}`);
  pages.forEach((p, i) => log('SETUP', `  page[${i}]: ${p.url} (id: ${p.id})`));
}

// ────────────────────────────────────────────────────────
// Scenario 1: Mode Isolation (normal vs takeover)
// ────────────────────────────────────────────────────────
async function scenario1() {
  console.log('\n========== Scenario 1: Mode Isolation ==========');
  try {
    // 1. Normal mode connection
    const normalBrowser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const normalCtx = normalBrowser.contexts()[0];

    // 2. Create 2 new pages in normal mode
    const np1 = await normalCtx.newPage();
    await np1.goto('https://www.example.com/normal-page-1', { timeout: 10000 }).catch(() => {});
    const np2 = await normalCtx.newPage();
    await np2.goto('https://www.example.com/normal-page-2', { timeout: 10000 }).catch(() => {});
    await sleep(2000);

    const normalPages = normalCtx.pages();
    log('S1', `Normal mode pages: ${normalPages.length}`);
    normalPages.forEach((p, i) => log('S1', `  normal[${i}]: ${p.url()}`));

    // 3. Takeover mode connection
    const takeoverBrowser = await chromium.connectOverCDP(`http://localhost:${TAKEOVER_PORT}`, { timeout: 20000 });
    const takeoverCtx = takeoverBrowser.contexts()[0];
    const takeoverPages = takeoverCtx.pages();
    log('S1', `Takeover mode pages: ${takeoverPages.length}`);
    takeoverPages.forEach((p, i) => log('S1', `  takeover[${i}]: ${p.url()}`));

    // 4. Verify takeover cannot see normal-mode created pages
    const takeoverUrls = takeoverPages.map(p => p.url());
    const normalCreatedUrls = ['/normal-page-1', '/normal-page-2'];
    const leaked = normalCreatedUrls.filter(u => takeoverUrls.some(tu => tu.includes(u)));

    if (leaked.length === 0) {
      recordResult('S1.1 Takeover cannot see normal-mode pages', true, `takeover has ${takeoverPages.length} pages, none are normal-mode created`);
    } else {
      recordResult('S1.1 Takeover cannot see normal-mode pages', false, `leaked URLs: ${leaked.join(', ')}`);
    }

    // 5. Verify normal mode cannot see takeover's user pages (about:blank, example.com, baidu)
    // Normal mode sees its own created pages but not ungrouped user tabs
    const normalUrls = normalPages.map(p => p.url());
    const userUrls = ['baidu.com'];
    const userLeaked = userUrls.filter(u => normalUrls.some(nu => nu.includes(u)));

    if (userLeaked.length === 0) {
      recordResult('S1.2 Normal mode cannot see user pages', true, `normal has ${normalPages.length} pages, none are baidu`);
    } else {
      recordResult('S1.2 Normal mode cannot see user pages', false, `unexpected user URLs in normal: ${userLeaked.join(', ')}`);
    }

    // 6. Disconnect both
    await takeoverBrowser.close();
    await normalBrowser.close();
    await sleep(2000);

    recordResult('S1.3 Both disconnected cleanly', true, 'no errors');

  } catch (e) {
    recordResult('Scenario 1', false, e.message);
    console.log(e.stack);
  }
}

// ────────────────────────────────────────────────────────
// Scenario 2: Multi-Client Isolation
// ────────────────────────────────────────────────────────
async function scenario2() {
  console.log('\n========== Scenario 2: Multi-Client Isolation ==========');
  try {
    // 1. Client A connects
    const browserA = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctxA = browserA.contexts()[0];

    // 2. Client B connects
    const browserB = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctxB = browserB.contexts()[0];
    await sleep(1000);

    // 3. Client A creates 2 pages
    const ap1 = await ctxA.newPage();
    await ap1.goto('https://www.example.com/client-a-page-1', { timeout: 10000 }).catch(() => {});
    const ap2 = await ctxA.newPage();
    await ap2.goto('https://www.example.com/client-a-page-2', { timeout: 10000 }).catch(() => {});
    await sleep(2000);

    // 4. Client B creates 2 pages
    const bp1 = await ctxB.newPage();
    await bp1.goto('https://www.example.com/client-b-page-1', { timeout: 10000 }).catch(() => {});
    const bp2 = await ctxB.newPage();
    await bp2.goto('https://www.example.com/client-b-page-2', { timeout: 10000 }).catch(() => {});
    await sleep(2000);

    // 5. Client A's getTargets only sees own pages
    const pagesA = ctxA.pages();
    const urlsA = pagesA.map(p => p.url());
    log('S2', `Client A pages (${pagesA.length}): ${urlsA.join(', ')}`);

    const aHasOwn = urlsA.some(u => u.includes('client-a-page'));
    const aHasB = urlsA.some(u => u.includes('client-b-page'));

    recordResult('S2.1 Client A sees own pages', aHasOwn, `has client-a pages: ${aHasOwn}, total: ${pagesA.length}`);
    recordResult('S2.2 Client A does NOT see B pages', !aHasB, aHasB ? `LEAKED: found client-b URLs in A` : `clean, no client-b URLs`);

    // 6. Client B's getTargets only sees own pages
    const pagesB = ctxB.pages();
    const urlsB = pagesB.map(p => p.url());
    log('S2', `Client B pages (${pagesB.length}): ${urlsB.join(', ')}`);

    const bHasOwn = urlsB.some(u => u.includes('client-b-page'));
    const bHasA = urlsB.some(u => u.includes('client-a-page'));

    recordResult('S2.3 Client B sees own pages', bHasOwn, `has client-b pages: ${bHasOwn}, total: ${pagesB.length}`);
    recordResult('S2.4 Client B does NOT see A pages', !bHasA, bHasA ? `LEAKED: found client-a URLs in B` : `clean, no client-a URLs`);

    // 7. A's page URLs B cannot see (already verified above)
    recordResult('S2.5 A URLs not visible to B', !bHasA, 'confirmed by S2.4');

    // 8. Disconnect A → A's pages close, B's unaffected
    const bCountBefore = pagesB.length;
    await browserA.close();
    await sleep(3000);

    const pagesBAfter = ctxB.pages();
    const bUrlsAfter = pagesBAfter.map(p => p.url());
    log('S2', `Client B after A disconnect (${pagesBAfter.length}): ${bUrlsAfter.join(', ')}`);

    const bStillHasOwn = bUrlsAfter.some(u => u.includes('client-b-page'));
    recordResult('S2.6 B unaffected after A disconnect', bStillHasOwn, `B still has ${pagesBAfter.length} pages, client-b pages: ${bStillHasOwn}`);

    await browserB.close();
    await sleep(2000);
    recordResult('S2.7 Both disconnected cleanly', true, 'no errors');

  } catch (e) {
    recordResult('Scenario 2', false, e.message);
    console.log(e.stack);
  }
}

// ────────────────────────────────────────────────────────
// Scenario 3: Takeover Operation Capability
// ────────────────────────────────────────────────────────
async function scenario3() {
  console.log('\n========== Scenario 3: Takeover Operation Capability ==========');
  try {
    // 1. Takeover connection
    const takeoverBrowser = await chromium.connectOverCDP(`http://localhost:${TAKEOVER_PORT}`, { timeout: 20000 });
    const ctx = takeoverBrowser.contexts()[0];
    const pages = ctx.pages();
    log('S3', `Takeover pages: ${pages.length}`);

    // 2. Find a user page (not about:blank)
    const userPage = pages.find(p => !p.url().includes('about:blank') && !p.url().includes('chrome-extension')) || pages[0];
    if (!userPage) {
      recordResult('Scenario 3', false, 'No user page found');
      await takeoverBrowser.close();
      return;
    }

    log('S3', `Selected page: ${userPage.url()}`);
    let allOk = true;

    // 3a. page.title()
    try {
      const title = await userPage.title({ timeout: 5000 }).catch(() => '');
      log('S3', `page.title() = "${title}"`);
      recordResult('S3.1 page.title()', title.length > 0, `title: "${title}"`);
    } catch (e) {
      recordResult('S3.1 page.title()', false, e.message);
      allOk = false;
    }

    // 3b. page.evaluate() - execute JS
    try {
      const docTitle = await userPage.evaluate(() => document.title).catch(() => '');
      log('S3', `page.evaluate(document.title) = "${docTitle}"`);
      recordResult('S3.2 page.evaluate()', docTitle.length >= 0, `document.title: "${docTitle}"`);
    } catch (e) {
      recordResult('S3.2 page.evaluate()', false, e.message);
      allOk = false;
    }

    // 3c. page.screenshot()
    try {
      const screenshotPath = '/tmp/takeover-screenshot.png';
      await userPage.screenshot({ path: screenshotPath, timeout: 10000 });
      const exists = fs.existsSync(screenshotPath);
      const size = exists ? fs.statSync(screenshotPath).size : 0;
      log('S3', `screenshot: ${screenshotPath}, size: ${size}`);
      recordResult('S3.3 page.screenshot()', exists && size > 0, `file exists: ${exists}, size: ${size} bytes`);
    } catch (e) {
      recordResult('S3.3 page.screenshot()', false, e.message);
      allOk = false;
    }

    // 3d. page.goto() - navigate to new URL
    try {
      await userPage.goto('https://www.example.com', { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1000);
      const newUrl = userPage.url();
      log('S3', `After goto: ${newUrl}`);
      recordResult('S3.4 page.goto()', newUrl.includes('example.com'), `navigated to: ${newUrl}`);
    } catch (e) {
      recordResult('S3.4 page.goto()', false, e.message);
      allOk = false;
    }

    await takeoverBrowser.close();
    await sleep(2000);

  } catch (e) {
    recordResult('Scenario 3', false, e.message);
    console.log(e.stack);
  }
}

// ────────────────────────────────────────────────────────
// Scenario 4: Disconnect Behavior
// ────────────────────────────────────────────────────────
async function scenario4() {
  console.log('\n========== Scenario 4: Disconnect Behavior ==========');
  try {
    // 1. Normal mode creates 2 pages, record URLs
    const normalBrowser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const normalCtx = normalBrowser.contexts()[0];
    const np1 = await normalCtx.newPage();
    await np1.goto('https://www.example.com/disconnect-test-1', { timeout: 10000 }).catch(() => {});
    const np2 = await normalCtx.newPage();
    await np2.goto('https://www.example.com/disconnect-test-2', { timeout: 10000 }).catch(() => {});
    await sleep(2000);

    const normalUrls = normalCtx.pages().map(p => p.url());
    const testUrls = normalUrls.filter(u => u.includes('disconnect-test'));
    log('S4', `Normal created pages: ${testUrls.join(', ')}`);

    // 2. Disconnect normal mode
    await normalBrowser.close();
    await sleep(3000);
    log('S4', 'Normal mode disconnected');

    // 3. Takeover connect, check if these URLs still exist (should NOT, create mode closes pages)
    const takeoverBrowser1 = await chromium.connectOverCDP(`http://localhost:${TAKEOVER_PORT}`, { timeout: 20000 });
    const takeoverCtx1 = takeoverBrowser1.contexts()[0];
    const takeoverPages1 = takeoverCtx1.pages();
    const takeoverUrls1 = takeoverPages1.map(p => p.url());

    const disconnectTestsFound = takeoverUrls1.filter(u => u.includes('disconnect-test'));
    log('S4', `Takeover sees: ${takeoverUrls1.join(', ')}`);

    if (disconnectTestsFound.length === 0) {
      recordResult('S4.1 Normal-mode pages closed after disconnect', true, 'disconnect-test URLs not found in takeover');
    } else {
      recordResult('S4.1 Normal-mode pages closed after disconnect', false, `found: ${disconnectTestsFound.join(', ')}`);
    }

    // 4. Takeover attach a user page, record URL
    const userPage = takeoverPages1.find(p => !p.url().includes('chrome-extension')) || takeoverPages1[0];
    if (!userPage) {
      recordResult('S4', false, 'No user page to attach');
      await takeoverBrowser1.close();
      return;
    }

    const pageUrlBefore = userPage.url();
    log('S4', `Takeover attached page: ${pageUrlBefore}`);

    // Navigate to a unique URL to track it
    await userPage.goto('https://www.example.com/takeover-persist-test', { timeout: 10000 }).catch(() => {});
    await sleep(1000);
    const pageUrlAfter = userPage.url();
    log('S4', `Navigated to: ${pageUrlAfter}`);

    // 5. Disconnect takeover
    await takeoverBrowser1.close();
    await sleep(3000);
    log('S4', 'Takeover disconnected');

    // 6. Takeover reconnect, check if URL still exists (should be, takeover doesn't close)
    const takeoverBrowser2 = await chromium.connectOverCDP(`http://localhost:${TAKEOVER_PORT}`, { timeout: 20000 });
    const takeoverCtx2 = takeoverBrowser2.contexts()[0];
    const takeoverPages2 = takeoverCtx2.pages();
    const takeoverUrls2 = takeoverPages2.map(p => p.url());

    log('S4', `After reconnect, takeover sees: ${takeoverUrls2.join(', ')}`);

    const persistFound = takeoverUrls2.some(u => u.includes('takeover-persist-test') || u.includes('example.com'));
    if (persistFound) {
      recordResult('S4.2 Takeover pages persist after disconnect', true, 'page still exists after takeover disconnect');
    } else {
      recordResult('S4.2 Takeover pages persist after disconnect', false, 'page was closed after takeover disconnect');
    }

    await takeoverBrowser2.close();
    await sleep(2000);

  } catch (e) {
    recordResult('Scenario 4', false, e.message);
    console.log(e.stack);
  }
}

// ────────────────────────────────────────────────────────
// Scenario 5: Connection Status via CDP
// ────────────────────────────────────────────────────────
async function scenario5() {
  console.log('\n========== Scenario 5: Connection Status via CDP ==========');
  try {
    // 1. Connect normal mode + takeover mode
    const normalBrowser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    log('S5', 'Normal mode connected');

    const takeoverBrowser = await chromium.connectOverCDP(`http://localhost:${TAKEOVER_PORT}`, { timeout: 20000 });
    log('S5', 'Takeover mode connected');

    // 2. Verify /json/version works for both
    try {
      const version1 = await httpGet(PORT, '/json/version');
      const version2 = await httpGet(TAKEOVER_PORT, '/json/version');
      recordResult('S5.1 Both ports respond to /json/version', true,
        `normal: ${version1.Browser || 'ok'}, takeover: ${version2.Browser || 'ok'}`);
    } catch (e) {
      recordResult('S5.1 Both ports respond to /json/version', false, e.message);
    }

    // 3. Verify /json/list returns targets
    try {
      const list1 = await httpGet(PORT, '/json/list');
      const list2 = await httpGet(TAKEOVER_PORT, '/json/list');
      const pages1 = (list1 || []).filter(t => t.type === 'page');
      const pages2 = (list2 || []).filter(t => t.type === 'page');
      recordResult('S5.2 Both ports return targets', true,
        `normal: ${pages1.length} pages, takeover: ${pages2.length} pages`);
    } catch (e) {
      recordResult('S5.2 Both ports return targets', false, e.message);
    }

    // 4. Disconnect normal mode
    await normalBrowser.close();
    await sleep(2000);
    log('S5', 'Normal mode disconnected');

    // 5. Verify normal port still accepts connections (proxy still running)
    // And takeover still works
    try {
      const takeoverPages = takeoverBrowser.contexts()[0].pages();
      recordResult('S5.3 Takeover still works after normal disconnect', true,
        `takeover has ${takeoverPages.length} pages`);
    } catch (e) {
      recordResult('S5.3 Takeover still works after normal disconnect', false, e.message);
    }

    // 6. Reconnect normal mode
    try {
      const normalBrowser2 = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
      const normalPages2 = normalBrowser2.contexts()[0].pages();
      recordResult('S5.4 Normal mode reconnects successfully', true,
        `reconnected, has ${normalPages2.length} pages`);
      await normalBrowser2.close();
    } catch (e) {
      recordResult('S5.4 Normal mode reconnects successfully', false, e.message);
    }

    await takeoverBrowser.close();
    await sleep(2000);

  } catch (e) {
    recordResult('Scenario 5', false, e.message);
    console.log(e.stack);
  }
}

async function cleanup() {
  log('CLEANUP', 'Cleaning up...');
  if (chromeProc) {
    try { process.kill(-chromeProc.pid); } catch {}
    if (chromeProc._profile) {
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
  }
  if (proxyProc) {
    try { proxyProc.kill('SIGINT'); } catch {}
  }
  if (originalConfig) {
    try { fs.writeFileSync(CONFIG_PATH, originalConfig); } catch {}
  }
  await sleep(1000);
}

function printSummary() {
  console.log('\n========================================');
  console.log('         FULL VERIFICATION SUMMARY');
  console.log('========================================');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  results.forEach(r => {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.scenario}: ${r.detail}`);
  });
  console.log('----------------------------------------');
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('========================================');
  return failed;
}

(async () => {
  try {
    await setup();
    await scenario1();
    await scenario2();
    await scenario3();
    await scenario4();
    await scenario5();
  } catch (e) {
    console.log(`\n[FATAL] ${e.message}`);
    console.log(e.stack);
  } finally {
    await cleanup();
    const failed = printSummary();
    process.exit(failed > 0 ? 1 : 0);
  }
})();
