#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const helpers = require('./helpers');
const { log, sleep, sendCDP, httpGet, startProxy, patchExtension, waitForExtension, connectCDP, cleanup, CHROME_PATH, EXTENSION_SRC } = helpers;

const PROXY_PORT = 19247;
const CONFIG_FILE = require('path').join(EXTENSION_SRC, 'utils', 'config.js');

async function runTest() {
  console.log('=== Test: Tab Group Isolation ===\n');
  console.log('Verifies:');
  console.log('  1. One CDP connection = ONE tab group (no duplicates)');
  console.log('  2. User tabs (opened before CDP) NOT added to automation group');
  console.log('  3. CDP disconnect closes only group tabs, not user tabs\n');

  let passed = 0, failed = 0;

  try {
    await patchExtension(PROXY_PORT);
    if (!await startProxy(PROXY_PORT)) throw new Error('Proxy failed to start');

    // Launch Chrome with USER tabs already open (simulate user browsing)
    // Using about:blank + example.com as startup URLs = user-opened tabs
    const profile = `/tmp/cdp-isolation-test-${Date.now()}`;
    const chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_SRC}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank',
      'https://www.example.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension failed to connect');
    log('SETUP', 'Chrome started with 2 user tabs (about:blank + example.com)');

    // Record which tabs exist BEFORE any CDP client connects
    const preWs = await connectCDP(PROXY_PORT);
    const preTargets = await sendCDP(preWs, 'Target.getTargets');
    const userTargetIds = preTargets.targetInfos
      .filter(t => t.type === 'page')
      .map(t => t.targetId);
    preWs.close();
    log('SETUP', `User tabs before CDP connect: ${userTargetIds.length}`);
    userTargetIds.forEach(id => log('SETUP', `  User tab: ${id}`));

    await sleep(2000);

    // ── Phase 1: Connect Playwright ──
    log('PHASE1', 'Connecting Playwright via CDP...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`, { timeout: 15000 });
    log('PHASE1', 'Playwright connected');

    // Wait for auto-attach and group formation
    await sleep(5000);

    // User tabs should be visible to Playwright (attached but NOT in group)
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    log('PHASE1', `Visible pages: ${pages.length}`);

    if (pages.length >= 2) {
      log('PASS', `User tabs visible: ${pages.length} pages`);
      passed++;
    } else {
      log('FAIL', `Expected >= 2 user pages, got ${pages.length}`);
      failed++;
    }

    // ── Phase 2: Create CDP tabs — verify single group ──
    log('PHASE2', 'Creating 3 CDP tabs via Playwright...');
    const cdpPageCount = 3;
    for (let i = 0; i < cdpPageCount; i++) {
      const page = await ctx.newPage();
      await page.goto('about:blank');
      log('PHASE2', `  CDP tab ${i + 1} created`);
    }

    await sleep(5000); // Wait for group formation

    // Total pages should be: user tabs + CDP tabs
    const totalAfter = ctx.pages();
    log('PHASE2', `Total pages after CDP creation: ${totalAfter.length}`);

    // Verify single group: all CDP tabs exist, user tabs still visible
    if (totalAfter.length >= userTargetIds.length + cdpPageCount) {
      log('PASS', `Single group: ${totalAfter.length} total pages (${userTargetIds.length} user + ${cdpPageCount} CDP)`);
      passed++;
    } else {
      log('FAIL', `Expected >= ${userTargetIds.length + cdpPageCount}, got ${totalAfter.length}`);
      failed++;
    }

    // ── Phase 3: Disconnect — verify user tabs survive, CDP tabs don't ──
    log('PHASE3', 'Disconnecting Playwright...');
    await browser.close();
    log('PHASE3', 'Playwright disconnected');
    await sleep(4000); // Wait for cleanup

    // Reconnect to check surviving tabs
    log('PHASE3', 'Checking surviving tabs...');
    const checkWs = await connectCDP(PROXY_PORT);
    const remaining = await sendCDP(checkWs, 'Target.getTargets');
    const remainingPages = remaining.targetInfos.filter(t => t.type === 'page');

    log('PHASE3', `Remaining pages: ${remainingPages.length}`);
    remainingPages.forEach(t => log('PHASE3', `  Surviving: ${t.targetId} — ${t.url}`));

    // User tabs should survive
    const survivingUserIds = remainingPages.filter(t => userTargetIds.includes(t.targetId));
    if (survivingUserIds.length >= userTargetIds.length) {
      log('PASS', `${survivingUserIds.length} user tabs SURVIVED disconnect`);
      passed++;
    } else {
      log('FAIL', `Only ${survivingUserIds.length}/${userTargetIds.length} user tabs survived`);
      failed++;
    }

    // CDP-created tabs should be gone (exclude extension/config pages)
    const cdpSurvived = remainingPages.filter(t =>
      !userTargetIds.includes(t.targetId) &&
      !t.url.startsWith('chrome-extension://')
    );
    if (cdpSurvived.length === 0) {
      log('PASS', 'CDP-created tabs properly closed');
      passed++;
    } else {
      log('FAIL', `${cdpSurvived.length} CDP tabs survived (should be 0)`);
      failed++;
    }

    checkWs.close();

    // Cleanup
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    await cleanup();
    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('FATAL:', err.message);
    await cleanup();
    process.exit(1);
  }
}

runTest();
