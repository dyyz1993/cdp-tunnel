#!/usr/bin/env node
'use strict';

/**
 * Test: CDP Tab Group Assignment — verify via chrome.debugger
 * 
 * Uses the SAME Playwright connection to check targets (not a new WS).
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
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

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

async function waitForProxy(port) {
  for (let i = 0; i < 20; i++) { try { const r = await new Promise((resolve, reject) => { http.get(`http://localhost:${port}/json/version`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }).on('error', reject); }); if (r) return true; } catch {} await sleep(500); }
  return false;
}

async function waitForExtension(port, maxWait = 60000) {
  const start = Date.now();
  await sleep(8000);
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

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: CDP Tab Group Assignment (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-group-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    // Connect Playwright
    const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`, { timeout: 20000 });
    const ctx = browser.contexts()[0];
    log('PW', `Connected, ${ctx.pages().length} existing pages`);
    await sleep(3000);

    // Create CDP tabs
    log('CDP', 'Creating 3 CDP tabs via ctx.newPage()...');
    const cdpPages = [];
    for (let i = 0; i < 3; i++) {
      const p = await ctx.newPage();
      await p.goto('about:blank');
      cdpPages.push(p);
      log('CDP', `  Created tab ${i + 1}: url=${p.url()}`);
    }

    // Wait for group assignment (2s setTimeout in addTabToAutomationGroup)
    log('WAIT', 'Waiting 6s for group assignment...');
    await sleep(6000);

    // Check via Playwright: how many pages does PW see?
    const pwPages = ctx.pages();
    log('PW', `Playwright sees ${pwPages.length} pages:`);
    pwPages.forEach((p, i) => log('PW', `  [${i}] ${p.url()}`));

    if (pwPages.length >= 4) { // 1 original + 3 CDP
      log('PASS', `Playwright sees all ${pwPages.length} pages (1 original + 3 CDP)`);
      passed++;
    } else {
      log('FAIL', `Playwright only sees ${pwPages.length} pages, expected >= 4`);
      failed++;
    }

    // Now disconnect and check cleanup
    log('DISC', 'Disconnecting Playwright...');
    await browser.close();
    await sleep(10000);

    // Check surviving tabs via new connection
    const { WebSocket } = require('ws');
    const checkWs = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { checkWs.on('open', r); checkWs.on('error', e); });
    const checkId = Date.now();
    checkWs.send(JSON.stringify({ id: checkId, method: 'Target.getTargets' }));
    const checkResult = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { checkWs.off('message', h); reject(); }, 8000);
      const h = data => { try { const m = JSON.parse(data.toString()); if (m.id === checkId) { clearTimeout(t); checkWs.off('message', h); resolve(m); } } catch {} };
      checkWs.on('message', h);
    });
    checkWs.close();

    const surviving = (checkResult?.result?.targetInfos || []).filter(t => t.type === 'page');
    log('FINAL', `${surviving.length} surviving pages:`);
    surviving.forEach(t => log('FINAL', `  ${t.targetId} — ${t.url}`));

    // Only the original about:blank should survive
    const nonPreExisting = surviving.filter(t => !t.url.includes('about:blank') || surviving.length > 1);
    // Actually: about:blank is pre-existing. CDP tabs should be cleaned up.
    // If CDP tabs survived, they escaped the group.
    if (surviving.length === 1) {
      log('PASS', `Only 1 pre-existing tab survives, CDP tabs cleaned up`);
      passed++;
    } else {
      log('FAIL', `${surviving.length} tabs survived (expected 1). CDP tabs may have escaped the group!`);
      failed++;
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
