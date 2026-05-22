#!/usr/bin/env node
'use strict';

/**
 * Test: Tab Group No Escape + Extension Console Monitoring
 *
 * 1. Launch Chromium with extension on a random port (not 9221)
 * 2. Connect to extension Service Worker via CDP to capture console logs
 * 3. Connect via Playwright (connectOverCDP)
 * 4. Create N tabs via ctx.newPage()
 * 5. Disconnect Playwright → verify all CDP tabs cleaned up (no escapes)
 * 6. Report extension console errors as test failures
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;

const extensionConsoleLogs = [];
const extensionErrors = [];

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  const patched = configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`);
  fs.writeFileSync(CONFIG_PATH, patched);
  log('PATCH', `Config patched to port ${port}`);
}

function restoreConfig() {
  if (configOriginal) {
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    configOriginal = null;
  }
}

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.floor(Math.random() * 10000);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`Timeout: ${method}`)); }, 20000);
    const h = data => {
      try {
        const m = JSON.parse(data.toString());
        if (m.id === id) { clearTimeout(t); ws.off('message', h); resolve(m); }
      } catch {}
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitForProxy(port) {
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', reject);
      });
      return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(6000);
  while (Date.now() - start < maxWait) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/list`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
        }).on('error', reject);
      });
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

/**
 * Read Chromium's chrome_debug.log from the user-data-dir.
 * With --enable-logging --v=1, console.log/error from service workers
 * are written to this file.
 */
function readChromeLogs(profileDir) {
  const logFile = path.join(profileDir, 'chrome_debug.log');
  if (!fs.existsSync(logFile)) {
    log('SW-MONITOR', `No chrome_debug.log at ${logFile}`);
    return;
  }
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const extPrefixes = ['[TabGroup]', '[Monitor]', '[WS]', '[CDP]', '[Init]', '[KeepAlive]'];
  const errors = [];
  const all = [];

  lines.forEach(line => {
    for (const prefix of extPrefixes) {
      if (line.includes(prefix)) {
        all.push(line.substring(0, 300));
        if (line.includes('ERROR') || line.includes('error') || line.includes('FAIL') || line.includes('exception')) {
          errors.push(line.substring(0, 300));
        }
        break;
      }
    }
  });

  log('SW-MONITOR', `Read ${lines.length} log lines, ${all.length} extension-related, ${errors.length} errors`);

  all.slice(-30).forEach(l => log('SW-LOG', l.substring(0, 200)));
  errors.forEach((e, i) => {
    log('SW-ERROR', `  ${i + 1}. ${e.substring(0, 200)}`);
    extensionErrors.push(e);
  });
  extensionConsoleLogs.push(...all.map(t => ({ type: errors.includes(t) ? 'error' : 'log', text: t })));
}

function cleanup() {
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

function dumpExtensionLogs() {
  console.log('\n--- Extension Console Summary ---');
  const errors = extensionConsoleLogs.filter(l => l.type === 'error' || l.type === 'exception');
  const warnings = extensionConsoleLogs.filter(l => l.type === 'warning');
  const info = extensionConsoleLogs.filter(l => l.type !== 'error' && l.type !== 'exception' && l.type !== 'warning');

  console.log(`  Total log entries: ${extensionConsoleLogs.length}`);
  console.log(`  Errors: ${errors.length}, Warnings: ${warnings.length}, Info: ${info.length}`);

  if (errors.length > 0) {
    console.log('\n  [ERRORS]:');
    errors.forEach((e, i) => console.log(`    ${i + 1}. ${e.text.substring(0, 200)}`));
  }
  if (warnings.length > 0) {
    console.log('\n  [WARNINGS]:');
    warnings.slice(-10).forEach((w, i) => console.log(`    ${i + 1}. ${w.text.substring(0, 200)}`));
  }
  console.log('---\n');
}

async function runTest() {
  const TAB_COUNT = 5;
  console.log(`\n=== Test: Tab Group No Escape + SW Console (port ${PORT}, ${TAB_COUNT} tabs) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);

    log('SETUP', 'Starting proxy server...');
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stdout.on('data', d => {
      d.toString().trim().split('\n').forEach(l => {
        if (l.includes('[TabGroup]') || l.includes('FAIL') || l.includes('ERROR')) {
          log('PROXY', l.substring(0, 300));
        }
      });
    });
    proxyProcess.stderr.on('data', d => {
      d.toString().trim().split('\n').forEach(l => {
        log('PROXY-ERR', l.substring(0, 300));
      });
    });

    if (!await waitForProxy(PORT)) throw new Error('Proxy failed to start');
    log('SETUP', 'Proxy ready');

    log('SETUP', 'Launching Chromium with extension...');
    const profile = `/tmp/cdp-no-escape-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      '--enable-logging', '--v=1',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = profile;

    if (!await waitForExtension(PORT)) throw new Error('Extension failed to connect');
    log('SETUP', 'Extension connected');

    // ── Phase 0: Note profile dir for log collection ──
    log('SW-MONITOR', `Extension logs will be read from ${profile} after test`);

    // ── Phase 1: Connect Playwright ──
    log('PW', 'Connecting Playwright...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    log('PW', `Connected. Existing pages: ${ctx.pages().length}`);
    await sleep(3000);

    const preExistingCount = ctx.pages().length;

    // ── Phase 2: Create CDP tabs ──
    log('CDP', `Creating ${TAB_COUNT} CDP tabs via ctx.newPage()...`);
    const cdpPages = [];
    for (let i = 0; i < TAB_COUNT; i++) {
      const page = await ctx.newPage();
      await page.goto('about:blank');
      cdpPages.push(page);
      log('CDP', `  Created tab ${i + 1}/${TAB_COUNT}`);
    }

    log('WAIT', 'Waiting 8s for group assignment...');
    await sleep(8000);

    // ── Phase 3: Disconnect ──
    log('DISC', 'Disconnecting Playwright...');
    await browser.close();

    log('WAIT', 'Waiting 10s for cleanup...');
    await sleep(10000);

    // ── Phase 4: Check surviving tabs ──
    log('CHECK', 'Checking surviving tabs...');
    const postWs = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { postWs.on('open', r); postWs.on('error', e); });

    const postTargets = await sendCDP(postWs, 'Target.getTargets');
    postWs.close();

    const survivingPages = (postTargets?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('CHECK', `Surviving pages: ${survivingPages.length}`);
    survivingPages.forEach(t => log('CHECK', `  Surviving: ${t.targetId} — ${t.url}`));

    // ── Phase 5: Read extension logs from chrome_debug.log ──
    log('SW-MONITOR', 'Reading extension console logs from chrome_debug.log...');
    readChromeLogs(profile);

    // ── Assertions ──

    // Assertion 1: No CDP tabs survived
    const nonExtSurviving = survivingPages.filter(t => !t.url.startsWith('chrome-extension://'));
    const escapedCount = Math.max(0, nonExtSurviving.length - preExistingCount);
    if (escapedCount === 0) {
      log('PASS', `All ${TAB_COUNT} CDP tabs properly tracked and cleaned up (no escapes)`);
      passed++;
    } else {
      log('FAIL', `${escapedCount} CDP tab(s) ESCAPED — not grouped/tracked!`);
      failed++;
    }

    // Assertion 2: No extension console errors
    const criticalErrors = extensionErrors.filter(e =>
      !e.includes('[WS] Closed') &&
      !e.includes('[WS] Attempting to reconnect') &&
      !e.includes('WebSocket')
    );
    if (criticalErrors.length === 0) {
      log('PASS', `Extension console: 0 critical errors (${extensionErrors.length} total, all WebSocket-related)`);
      passed++;
    } else {
      log('FAIL', `Extension console: ${criticalErrors.length} critical errors`);
      criticalErrors.forEach((e, i) => log('FAIL-DETAIL', `  ${i + 1}. ${e.substring(0, 200)}`));
      failed++;
    }

    // Assertion 3: Extension logged tab group activity
    const groupLogs = extensionConsoleLogs.filter(l =>
      l.text.includes('[TabGroup]') || l.text.includes('TabGroup')
    );
    if (groupLogs.length > 0) {
      log('PASS', `Extension logged ${groupLogs.length} tab group operations`);
      passed++;
    } else {
      log('WARN', `No [TabGroup] logs found in extension console`);
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
  } finally {
    dumpExtensionLogs();
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
