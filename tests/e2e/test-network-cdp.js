#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const {
  log, sleep, httpGet, startProxy, patchExtension,
  startBrowser, waitForExtension, cleanup, CHROME_PATH
} = require('./helpers');

const PROXY_PORT = 10000 + Math.floor(Math.random() * 50000);
if (PROXY_PORT === 9221) process.exit(1);

const TEST_URLS = [
  'https://httpbin.org/get',
  'https://www.example.com'
];

const results = [];

function record(name, passed, detail = '') {
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${name}${detail ? ' - ' + detail : ''}`);
  results.push({ name, passed, detail });
}

async function pickReachableUrl() {
  for (const url of TEST_URLS) {
    try {
      const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (resp.ok || resp.status < 400) return url;
    } catch {}
  }
  return TEST_URLS[TEST_URLS.length - 1];
}

async function connectPlaywright(proxyPort) {
  log('PW', `Connecting to http://localhost:${proxyPort} ...`);
  const browser = await chromium.connectOverCDP(`http://localhost:${proxyPort}`);
  log('PW', `Connected, contexts: ${browser.contexts().length}`);
  return browser;
}

async function createPage(browser) {
  const contexts = browser.contexts();
  let ctx = contexts[0];
  if (!ctx) ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { page, ctx };
}

async function createPageAndCDPSession(browser) {
  const { page, ctx } = await createPage(browser);
  const cdpSession = await ctx.newCDPSession(page);
  return { page, cdpSession, ctx };
}

async function testNetworkRequestEvents(browser) {
  const testName = 'CDP Network.requestWillBeSent';
  try {
    const { page, cdpSession, ctx } = await createPageAndCDPSession(browser);

    await cdpSession.send('Network.enable');

    const requestEvents = [];
    cdpSession.on('Network.requestWillBeSent', (params) => {
      requestEvents.push(params);
    });

    const targetUrl = await pickReachableUrl();
    log('NAV', `Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);

    const hasEvents = requestEvents.length >= 1;
    const hasMatchingUrl = requestEvents.some(
      (e) => e.request && e.request.url && (
        e.request.url.includes('httpbin.org') ||
        e.request.url.includes('example.com')
      )
    );

    record(testName, hasEvents && hasMatchingUrl,
      `events=${requestEvents.length}, urlMatch=${hasMatchingUrl}`);

    if (!hasEvents) {
      log('WARN', 'No CDP request events via session - sessionId mismatch likely');
    }

    await page.close();
    return hasEvents && hasMatchingUrl;
  } catch (err) {
    record(testName, false, err.message);
    return false;
  }
}

async function testNetworkResponseEvents(browser) {
  const testName = 'CDP Network.responseReceived';
  try {
    const { page, cdpSession } = await createPageAndCDPSession(browser);

    await cdpSession.send('Network.enable');

    const responseEvents = [];
    cdpSession.on('Network.responseReceived', (params) => {
      responseEvents.push(params);
    });

    const targetUrl = await pickReachableUrl();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);

    const hasEvents = responseEvents.length >= 1;
    const hasStatusCode = responseEvents.some(
      (e) => e.response && typeof e.response.status === 'number' &&
        (e.response.status === 200 || e.response.status === 301 || e.response.status === 302)
    );

    if (hasEvents && responseEvents.length > 0) {
      const firstStatus = responseEvents[0]?.response?.status;
      log('DETAIL', `  First response status: ${firstStatus}`);
    }

    record(testName, hasEvents && hasStatusCode,
      `events=${responseEvents.length}, hasValidStatus=${hasStatusCode}`);

    await page.close();
    return hasEvents && hasStatusCode;
  } catch (err) {
    record(testName, false, err.message);
    return false;
  }
}

async function testRuntimeEvaluate(browser) {
  const testName = 'CDP Runtime.evaluate';
  try {
    const { page, cdpSession } = await createPageAndCDPSession(browser);

    const result = await cdpSession.send('Runtime.evaluate', {
      expression: '1 + 1'
    });

    const value = result?.result?.value;
    const passed = value === 2;

    record(testName, passed, `1+1 = ${value}`);
    log('DETAIL', `  Result: ${JSON.stringify(result?.result)}`);

    await page.close();
    return passed;
  } catch (err) {
    record(testName, false, err.message);
    return false;
  }
}

async function testPlaywrightRequestEvents(browser) {
  const testName = 'PW page.on("request")';
  try {
    const { page } = await createPage(browser);

    const requests = [];
    page.on('request', (req) => {
      requests.push(req);
    });

    const targetUrl = await pickReachableUrl();
    log('NAV', `Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    const hasRequests = requests.length >= 1;
    const hasMatchingUrl = requests.some(
      (r) => r.url().includes('httpbin.org') || r.url().includes('example.com')
    );

    record(testName, hasRequests && hasMatchingUrl,
      `requests=${requests.length}, urlMatch=${hasMatchingUrl}`);

    if (hasRequests) {
      log('DETAIL', `  First request: ${requests[0].url()}`);
    }

    await page.close();
    return hasRequests && hasMatchingUrl;
  } catch (err) {
    record(testName, false, err.message);
    return false;
  }
}

async function testPlaywrightResponseEvents(browser) {
  const testName = 'PW page.on("response")';
  try {
    const { page } = await createPage(browser);

    const responses = [];
    page.on('response', (resp) => {
      responses.push(resp);
    });

    const targetUrl = await pickReachableUrl();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    const hasResponses = responses.length >= 1;
    const hasOkStatus = responses.some(
      (r) => r.status() === 200 || r.status() === 301 || r.status() === 302
    );

    if (hasResponses) {
      log('DETAIL', `  First response status: ${responses[0].status()} url: ${responses[0].url()}`);
    }

    record(testName, hasResponses && hasOkStatus,
      `responses=${responses.length}, hasValidStatus=${hasOkStatus}`);

    await page.close();
    return hasResponses && hasOkStatus;
  } catch (err) {
    record(testName, false, err.message);
    return false;
  }
}

async function runTests() {
  console.log('\n=== CDP Network Domain E2E Tests ===\n');

  try {
    log('SETUP', 'Patching extension config...');
    await patchExtension(PROXY_PORT);

    log('SETUP', `Starting proxy on port ${PROXY_PORT}...`);
    const proxyOk = await startProxy(PROXY_PORT);
    if (!proxyOk) throw new Error('Proxy failed to start');
    log('SETUP', 'Proxy ready');

    log('SETUP', 'Starting Chrome...');
    await startBrowser();
    log('SETUP', 'Chrome started');

    log('SETUP', 'Waiting for extension...');
    const extOk = await waitForExtension(PROXY_PORT);
    if (!extOk) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(2000);

    const browser = await connectPlaywright(PROXY_PORT);

    console.log('\n--- Test 1: CDP Network.enable + requestWillBeSent ---');
    await testNetworkRequestEvents(browser);

    console.log('\n--- Test 2: CDP Network.responseReceived ---');
    await testNetworkResponseEvents(browser);

    console.log('\n--- Test 3: CDP Runtime.evaluate ---');
    await testRuntimeEvaluate(browser);

    console.log('\n--- Test 4: Playwright page.on("request") ---');
    await testPlaywrightRequestEvents(browser);

    console.log('\n--- Test 5: Playwright page.on("response") ---');
    await testPlaywrightResponseEvents(browser);

    console.log('\n--- Cleanup ---');
    try { await browser.close(); } catch {}
    cleanup();

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nFATAL:', err.message);
    console.error(err.stack);

    if (results.length > 0) {
      console.log('\n=== Partial Results ===');
      results.forEach(r => {
        console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' - ' + r.detail : ''}`);
      });
    }

    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });

runTests();
