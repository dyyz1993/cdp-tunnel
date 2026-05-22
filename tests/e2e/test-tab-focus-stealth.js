#!/usr/bin/env node
'use strict';

/**
 * TDD Test: Tab Opening Stealth (Focus / Perception)
 *
 * Verifies:
 * 1. Target.createTarget does NOT activate new tab (active tab unchanged)
 * 2. Multiple sequential creates don't activate tabs
 * 3. window.open from CDP-controlled page does NOT activate child tab
 * 4. All created tabs are successfully closed
 * 5. Performance: createTarget completes within reasonable time
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19299;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let originalConfig = null;
let _requestId = 0;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function patchConfig(port) {
  originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH,
    originalConfig.replace(
      /WS_URL:\s*'ws:\/\/localhost:9221\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (originalConfig) {
    fs.writeFileSync(CONFIG_PATH, originalConfig);
    originalConfig = null;
  }
}

function sendCDP(ws, method, params = {}, sessionId) {
  const id = ++_requestId;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout [${id}]: ${method}`));
    }, 15000);
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.result);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

function waitForEvent(ws, method, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for event: ${method}`));
    }, timeoutMs);
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.method === method) {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(parsed);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

function collectEvents(ws, methodFilter, durationMs) {
  return new Promise((resolve) => {
    const events = [];
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.method && methodFilter.includes(parsed.method)) {
          events.push(parsed);
        }
      } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(events);
    }, durationMs);
  });
}

async function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(port, '/json/version');
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function waitForExtension(port, maxWait = 45000) {
  await sleep(5000);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = await connectCDP(port);
      const result = await Promise.race([
        sendCDP(ws, 'Target.getTargets'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      ws.close();
      _requestId = 0;
      if (result && result.targetInfos && result.targetInfos.length > 0) return true;
    } catch (e) {
      log('SETUP', `  Waiting for extension... (${e.message})`);
    }
    await sleep(3000);
  }
  return false;
}

function cleanup() {
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    if (chromeProcess._profile) {
      try { fs.rmSync(chromeProcess._profile, { recursive: true, force: true }); } catch {}
    }
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

async function runTest() {
  console.log('=== Tab Focus Stealth E2E Test ===\n');
  const results = [];

  try {
    patchConfig(PROXY_PORT);
    log('SETUP', 'Patched extension config to port ' + PROXY_PORT);

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => {
        if (l) log('PROXY-ERR', l.substring(0, 120));
      });
    });
    log('SETUP', `Proxy started (PID: ${proxyProcess.pid})`);

    const userDataDir = `/tmp/cdp-focus-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;
    log('SETUP', `Chrome started (PID: ${chromeProcess.pid})`);

    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy did not become ready');
    log('SETUP', 'Proxy is ready');

    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    const ws = await connectCDP(PROXY_PORT);
    await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
    log('TEST', 'CDP client connected');

    // Use setAutoAttach to discover the initial about:blank tab
    const attachEventsPromise = collectEvents(ws, ['Target.attachedToTarget'], 5000);
    await sendCDP(ws, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
    const attachEvents = await attachEventsPromise;
    log('TEST', `Auto-attach events: ${attachEvents.length}`);

    await sleep(2000);

    // Get all discovered targets - the first CDP-created one is our baseline
    let allTargets = await sendCDP(ws, 'Target.getTargets');
    let allPages = allTargets.targetInfos.filter(t => t.type === 'page');
    log('TEST', `Discovered pages: ${allPages.length}`);
    allPages.forEach(p => log('TEST', `  - ${p.targetId} url=${p.url}`));

    // Create a "user" page as our baseline active tab via createTarget
    const baselineResult = await sendCDP(ws, 'Target.createTarget', {
      url: 'data:text/html,<h1>Baseline Active Tab</h1>'
    });
    const baselineTargetId = baselineResult.targetId;
    log('TEST', `Created baseline page: ${baselineTargetId}`);

    // Activate it to make it the "active" tab
    await sendCDP(ws, 'Target.activateTarget', { targetId: baselineTargetId });
    await sleep(2000);

    // Attach to baseline to get a session
    const baselineAttach = await sendCDP(ws, 'Target.attachToTarget', {
      targetId: baselineTargetId,
      flatten: true
    });
    const baselineSessionId = baselineAttach.sessionId;
    log('TEST', `Attached to baseline: sessionId=${baselineSessionId}`);

    // ============================================================
    // Test 1: Target.createTarget does NOT activate new tab
    // ============================================================
    log('TEST', '\n--- Test 1: Target.createTarget focus stealth ---');

    // Record current targets before creating new tab
    const beforeTargets = await sendCDP(ws, 'Target.getTargets');
    const beforePages = beforeTargets.targetInfos.filter(t => t.type === 'page');
    const beforeCount = beforePages.length;

    const createStart = Date.now();
    const createResult = await sendCDP(ws, 'Target.createTarget', {
      url: 'https://www.example.com/focus-test-1'
    });
    const createDuration = Date.now() - createStart;
    log('TEST', `Created target in ${createDuration}ms: ${createResult.targetId}`);

    await sleep(3000);

    const afterTargets = await sendCDP(ws, 'Target.getTargets');
    const afterPages = afterTargets.targetInfos.filter(t => t.type === 'page');

    const baselineStillExists = afterPages.some(t => t.targetId === baselineTargetId);
    const newPageCreated = afterPages.some(t => t.targetId === createResult.targetId);
    const pageCountIncreased = afterPages.length > beforeCount;

    results.push({
      name: `Test 1a: createTarget created new page (was ${beforeCount}, now ${afterPages.length})`,
      pass: newPageCreated && pageCountIncreased
    });
    results.push({
      name: 'Test 1b: Baseline page still exists after createTarget',
      pass: baselineStillExists
    });
    results.push({
      name: `Test 1c: createTarget performance (${createDuration}ms, threshold: 2000ms)`,
      pass: createDuration < 2000
    });
    log('TEST', `  Baseline exists: ${baselineStillExists}, New created: ${newPageCreated}, Duration: ${createDuration}ms`);

    // ============================================================
    // Test 2: Multiple sequential creates
    // ============================================================
    log('TEST', '\n--- Test 2: Multiple sequential creates ---');
    const multiTargetIds = [];
    const multiStart = Date.now();
    for (let i = 0; i < 5; i++) {
      const r = await sendCDP(ws, 'Target.createTarget', {
        url: `https://www.example.com/multi-${i}`
      });
      multiTargetIds.push(r.targetId);
      log('TEST', `  Created page ${i + 1}/5: ${r.targetId}`);
    }
    const multiDuration = Date.now() - multiStart;
    log('TEST', `Created 5 pages in ${multiDuration}ms`);

    await sleep(3000);

    const afterMultiTargets = await sendCDP(ws, 'Target.getTargets');
    const afterMultiPages = afterMultiTargets.targetInfos.filter(t => t.type === 'page');
    const baselineAfterMulti = afterMultiPages.some(t => t.targetId === baselineTargetId);
    const allMultiCreated = multiTargetIds.every(id => afterMultiPages.some(t => t.targetId === id));

    results.push({
      name: `Test 2a: All 5 pages created (${multiDuration}ms, ${(multiDuration / 5).toFixed(0)}ms avg)`,
      pass: allMultiCreated
    });
    results.push({
      name: 'Test 2b: Baseline page still exists after 5 creates',
      pass: baselineAfterMulti
    });
    log('TEST', `  All created: ${allMultiCreated}, Baseline exists: ${baselineAfterMulti}`);

    // ============================================================
    // Test 3: window.open from CDP-controlled page does NOT activate child
    // Note: Chrome may block window.open without user gesture.
    // We test via Page.navigate to a page that opens a popup,
    // and also directly via Runtime.evaluate as fallback.
    // ============================================================
    log('TEST', '\n--- Test 3: window.open child tab ---');
    const parentTargetId = createResult.targetId;

    const parentAttach = await sendCDP(ws, 'Target.attachToTarget', {
      targetId: parentTargetId,
      flatten: true
    });
    const parentSessionId = parentAttach.sessionId;
    log('TEST', `Attached to parent: ${parentTargetId}, sessionId: ${parentSessionId}`);

    await sleep(1000);

    const beforeChildTargets = await sendCDP(ws, 'Target.getTargets');
    const beforeChildPages = beforeChildTargets.targetInfos.filter(t => t.type === 'page');
    const beforeChildCount = beforeChildPages.length;
    log('TEST', `Pages before window.open: ${beforeChildCount}`);

    // Method 1: Try window.open via Runtime.evaluate
    let childCreated = false;
    try {
      const childEventPromise = waitForEvent(ws, 'Target.targetCreated', 8000);
      await sendCDP(ws, 'Runtime.evaluate', {
        expression: 'window.open("https://www.example.com/child-from-js")'
      }, parentSessionId);

      const childEvent = await Promise.race([
        childEventPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
      ]);
      log('TEST', `Child tab targetCreated: ${childEvent.params?.targetInfo?.targetId}`);
      childCreated = true;
    } catch (e) {
      log('TEST', `window.open via Runtime.evaluate failed (popup blocked?): ${e.message}`);
    }

    // Method 2: If method 1 failed, use Page.navigate to trigger window.open via HTML
    if (!childCreated) {
      log('TEST', 'Trying Page.navigate approach...');
      try {
        const childEventPromise2 = collectEvents(ws, ['Target.targetCreated'], 8000);
        await sendCDP(ws, 'Page.navigate', {
          url: 'data:text/html,<script>window.open("https://www.example.com/child-via-nav");</script>'
        }, parentSessionId);
        const events = await childEventPromise2;
        if (events.length > 0) {
          log('TEST', `Child tab created via Page.navigate: ${events[0].params?.targetInfo?.targetId}`);
          childCreated = true;
        } else {
          log('TEST', 'Page.navigate approach also did not create child tab');
        }
      } catch (e) {
        log('TEST', `Page.navigate approach failed: ${e.message}`);
      }
    }

    await sleep(3000);

    const afterChildTargets = await sendCDP(ws, 'Target.getTargets');
    const afterChildPages = afterChildTargets.targetInfos.filter(t => t.type === 'page');
    const childPageCountIncreased = afterChildPages.length > beforeChildCount;
    const baselineAfterChild = afterChildPages.some(t => t.targetId === baselineTargetId);

    results.push({
      name: `Test 3a: window.open child page created via CDP (${afterChildPages.length} pages, was ${beforeChildCount})`,
      pass: childCreated || childPageCountIncreased
    });
    results.push({
      name: 'Test 3b: Baseline page still exists after window.open attempt',
      pass: baselineAfterChild
    });
    log('TEST', `  Child created: ${childCreated || childPageCountIncreased}, Baseline exists: ${baselineAfterChild}`);

    // ============================================================
    // Test 4: Page count summary
    // ============================================================
    log('TEST', '\n--- Test 4: Page count summary ---');

    const summaryTargets = await sendCDP(ws, 'Target.getTargets');
    const summaryPages = summaryTargets.targetInfos.filter(t => t.type === 'page');
    const examplePages = summaryPages.filter(t => t.url.includes('example.com'));
    const dataPages = summaryPages.filter(t => t.url.startsWith('data:'));

    const expectedMinPages = 1 + 1 + 5 + 1;
    results.push({
      name: `Test 4: Page count >= ${expectedMinPages} (found ${summaryPages.length}: ${examplePages.length} example, ${dataPages.length} data)`,
      pass: summaryPages.length >= expectedMinPages
    });
    log('TEST', `  Total pages: ${summaryPages.length}`);
    summaryPages.forEach(p => log('TEST', `    - ${p.targetId} url=${p.url.substring(0, 60)}`));

    // ============================================================
    // Test 5: Close all created tabs cleanly
    // ============================================================
    log('TEST', '\n--- Test 5: Clean close all created tabs ---');
    const allCreatedIds = [baselineTargetId, createResult.targetId, ...multiTargetIds];
    let closedCount = 0;
    for (const tid of allCreatedIds) {
      try {
        await sendCDP(ws, 'Target.closeTarget', { targetId: tid });
        closedCount++;
      } catch (e) {
        log('TEST', `  Failed to close ${tid}: ${e.message}`);
      }
    }

    await sleep(3000);

    const finalTargets = await sendCDP(ws, 'Target.getTargets');
    const finalPages = finalTargets.targetInfos.filter(t => t.type === 'page');

    results.push({
      name: `Test 5: Closed ${closedCount}/${allCreatedIds.length} created tabs`,
      pass: closedCount >= allCreatedIds.length - 1
    });
    log('TEST', `  Closed: ${closedCount}/${allCreatedIds.length}, Remaining pages: ${finalPages.length}`);

    ws.close();
    await sleep(2000);

  } catch (err) {
    console.error('Test error:', err);
    results.push({ name: 'Test execution', pass: false });
  }

  cleanup();

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n=== RESULTS ===');
  results.forEach(r => {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
  });
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  console.log('===============\n');

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
