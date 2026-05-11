#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const helpers = require('./helpers');
const { log, sleep, sendCDP, httpGet, startProxy, patchExtension, waitForExtension, connectCDP, cleanup, CHROME_PATH, EXTENSION_SRC } = helpers;

const PROXY_PORT = 19248;
const fs = require('fs');
const path = require('path');
const CONFIG_FILE = path.join(EXTENSION_SRC, 'utils', 'config.js');

async function runTest() {
  console.log('=== Test: Multi-Client Group Isolation ===\n');
  console.log('Scenario:');
  console.log('  1. User opens Baidu + example.com BEFORE any CDP');
  console.log('  2. Client-A connects, creates 2 tabs');
  console.log('  3. Client-B connects, creates 2 tabs');
  console.log('  4. Disconnect Client-A → only Group-A closes, Client-B and user tabs survive');
  console.log('  5. Disconnect Client-B → only Group-B closes, user tabs survive\n');

  let passed = 0, failed = 0;

  try {
    await patchExtension(PROXY_PORT);
    if (!await startProxy(PROXY_PORT)) throw new Error('Proxy failed');

    // Chrome with USER tabs already open
    const profile = `/tmp/cdp-multi-isolation-${Date.now()}`;
    const chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_SRC}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank',
      'https://www.example.com'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension failed');
    log('SETUP', 'Chrome started with 2 user tabs');

    // Record user tab IDs
    const preWs = await connectCDP(PROXY_PORT);
    const preTargets = await sendCDP(preWs, 'Target.getTargets');
    const userTargetIds = preTargets.targetInfos
      .filter(t => t.type === 'page')
      .map(t => t.targetId);
    preWs.close();
    log('SETUP', `User tabs: ${userTargetIds.length}`);
    await sleep(2000);

    // ── Phase 1: Client-A connects and creates tabs ──
    log('PHASE1', 'Connecting Client-A (Playwright)...');
    const browserA = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`, { timeout: 15000 });
    const ctxA = browserA.contexts()[0];

    const cdpAPages = [];
    for (let i = 0; i < 2; i++) {
      const p = await ctxA.newPage();
      await p.goto('about:blank');
      cdpAPages.push(p);
      log('PHASE1', `  Client-A tab ${i + 1} created`);
    }
    log('PHASE1', `Client-A: ${ctxA.pages().length} pages`);
    await sleep(3000);

    // ── Phase 2: Client-B connects and creates tabs ──
    log('PHASE2', 'Connecting Client-B (raw CDP)...');
    const wsB = await connectCDP(PROXY_PORT);
    await sendCDP(wsB, 'Target.setDiscoverTargets', { discover: true });
    await sendCDP(wsB, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    const cdpBTargetIds = [];
    for (let i = 0; i < 2; i++) {
      const r = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
      cdpBTargetIds.push(r.targetId);
      log('PHASE2', `  Client-B tab ${i + 1} created: ${r.targetId}`);
    }
    await sleep(5000);

    // Verify both clients are alive
    log('PHASE2', 'Verifying both clients alive...');
    const aPages = ctxA.pages();
    const bTargets = await sendCDP(wsB, 'Target.getTargets');
    const bPages = bTargets.targetInfos.filter(t => t.type === 'page');

    log('PHASE2', `Client-A sees ${aPages.length} pages, Client-B sees ${bPages.length} pages`);

    if (aPages.length >= 2) {
      log('PASS', 'Client-A has its tabs');
      passed++;
    } else {
      log('FAIL', `Client-A only has ${aPages.length} pages`);
      failed++;
    }
    if (bPages.length >= 2) {
      log('PASS', 'Client-B has its tabs');
      passed++;
    } else {
      log('FAIL', `Client-B only has ${bPages.length} pages`);
      failed++;
    }

    // ── Phase 3: Disconnect Client-A ──
    log('PHASE3', 'Disconnecting Client-A...');
    await browserA.close();
    await sleep(5000);
    log('PHASE3', 'Client-A disconnected');

    // Check: Client-B still works?
    let bAlive = false;
    try {
      const check = await sendCDP(wsB, 'Target.getTargets');
      bAlive = check && check.targetInfos && check.targetInfos.length > 0;
      const bRemaining = check.targetInfos.filter(t => t.type === 'page');
      log('PHASE3', `Client-B still sees ${bRemaining.length} pages`);
    } catch (e) {
      log('PHASE3', `Client-B error: ${e.message}`);
    }

    if (bAlive) {
      log('PASS', 'Client-B still alive after Client-A disconnect');
      passed++;
    } else {
      log('FAIL', 'Client-B died after Client-A disconnect');
      failed++;
    }

    // Check: User tabs survived?
    const survWs = await connectCDP(PROXY_PORT);
    const survTargets = await sendCDP(survWs, 'Target.getTargets');
    const survPages = survTargets.targetInfos.filter(t => t.type === 'page');
    survWs.close();

    const survivingUser = survPages.filter(t => userTargetIds.includes(t.targetId));
    log('PHASE3', `User tabs after Client-A disconnect: ${survivingUser.length}/${userTargetIds.length}`);
    survivingUser.forEach(t => log('PHASE3', `  User tab alive: ${t.targetId} — ${t.url}`));

    if (survivingUser.length >= userTargetIds.length) {
      log('PASS', 'All user tabs survived Client-A disconnect');
      passed++;
    } else {
      log('FAIL', `Only ${survivingUser.length}/${userTargetIds.length} user tabs survived`);
      failed++;
    }

    // Check: Client-A's tabs gone, Client-B's tabs still there?
    const aTargetsGone = survPages.filter(t =>
      !userTargetIds.includes(t.targetId) &&
      !t.url.startsWith('chrome-extension://') &&
      !cdpBTargetIds.includes(t.targetId)
    );
    const bTargetsAlive = survPages.filter(t => cdpBTargetIds.includes(t.targetId));

    // Check: Client-B still fully functional? (can create new tabs)
    let bCanCreate = false;
    try {
      const newTab = await sendCDP(wsB, 'Target.createTarget', { url: 'about:blank' });
      if (newTab && newTab.targetId) {
        bCanCreate = true;
        log('PHASE3', `Client-B created new tab: ${newTab.targetId}`);
        await sendCDP(wsB, 'Target.closeTarget', { targetId: newTab.targetId });
      }
    } catch (e) {
      log('PHASE3', `Client-B create error: ${e.message}`);
    }

    log('PHASE3', `Client-A orphan tabs: ${aTargetsGone.length}, Client-B alive=${bAlive}, canCreate=${bCanCreate}`);

    if (aTargetsGone.length === 0) {
      log('PASS', 'Client-A tabs properly closed');
      passed++;
    } else {
      log('FAIL', `${aTargetsGone.length} Client-A tabs survived`);
      failed++;
    }
    if (bAlive && bCanCreate) {
      log('PASS', 'Client-B fully functional after Client-A disconnect');
      passed++;
    } else {
      log('FAIL', `Client-B broken: alive=${bAlive}, canCreate=${bCanCreate}`);
      failed++;
    }

    // ── Phase 4: Disconnect Client-B ──
    log('PHASE4', 'Disconnecting Client-B...');
    wsB.close();
    await sleep(5000);
    log('PHASE4', 'Client-B disconnected');

    // Check: User tabs STILL survived?
    const finalWs = await connectCDP(PROXY_PORT);
    const finalTargets = await sendCDP(finalWs, 'Target.getTargets');
    const finalPages = finalTargets.targetInfos.filter(t => t.type === 'page');
    finalWs.close();

    const finalUser = finalPages.filter(t => userTargetIds.includes(t.targetId));
    const finalNonUser = finalPages.filter(t =>
      !userTargetIds.includes(t.targetId) &&
      !t.url.startsWith('chrome-extension://')
    );

    log('PHASE4', `Final state: ${finalPages.length} pages total`);
    finalPages.forEach(t => log('PHASE4', `  Remaining: ${t.targetId} — ${t.url}`));

    if (finalUser.length >= userTargetIds.length) {
      log('PASS', 'User tabs survived BOTH disconnects');
      passed++;
    } else {
      log('FAIL', `User tabs lost: ${finalUser.length}/${userTargetIds.length}`);
      failed++;
    }

    if (finalNonUser.length === 0) {
      log('PASS', 'All CDP tabs cleaned up');
      passed++;
    } else {
      log('FAIL', `${finalNonUser.length} CDP tabs leaked`);
      failed++;
    }

    // Cleanup
    try { process.kill(-chromeProc.pid, 'SIGKILL'); } catch {}
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
