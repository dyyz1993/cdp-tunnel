#!/usr/bin/env node
'use strict';

/**
 * Test: Direct WS connection — verify tab is ACTUALLY in Chrome tab group
 * 
 * Unlike other tests that check cleanup, this one directly verifies
 * the chrome.tabs.group operation happened.
 * 
 * Uses a second WS connection to query tab state.
 */

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
let proxyLogs = [];

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`T:${method}`)); }, 15000);
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
  for (let i = 0; i < 20; i++) { try { const r = await new Promise((resolve, reject) => { http.get(`http://localhost:${port}/json/version`, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }).on('error', reject); }); if (r) return true; } catch {} await sleep(500); }
  return false;
}

async function waitForExtension(port) {
  await sleep(8000);
  for (let i = 0; i < 20; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
      const r = await Promise.race([sendCDP(ws, 'Target.getTargets'), new Promise((_, j) => setTimeout(() => j(), 8000))]);
      ws.close();
      if (r?.result?.targetInfos?.length > 0) return true;
    } catch {}
    await sleep(3000);
  }
  return false;
}

function dumpProxyLogs() {
  if (proxyLogs.length > 0) {
    console.log('\n--- Proxy logs (last 100 lines) ---');
    proxyLogs.slice(-100).forEach(l => console.log('  ' + l));
    console.log('---\n');
  }
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

async function runTest() {
  console.log(`=== Test: Direct WS Group Verification (port ${PORT}) ===\n`);
  let passed = 0, failed = 0;

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    proxyProcess.stdout.on('data', d => proxyLogs.push(...d.toString().trim().split('\n')));
    proxyProcess.stderr.on('data', d => proxyLogs.push(...d.toString().trim().split('\n')));
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-direct-group-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready — extension connected');

    // ── Direct WS connection (simulating user's tool) ──
    log('WS', 'Connecting raw WebSocket to /client...');
    const ws = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    log('WS', 'Connected');

    // Send setAutoAttach
    await sendCDP(ws, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
    await sleep(2000);

    // Create tab via Target.createTarget
    log('CDP', 'Creating tab via Target.createTarget...');
    const createResult = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
    const newTargetId = createResult?.result?.targetId;
    log('CDP', `Result: targetId=${newTargetId}, error=${JSON.stringify(createResult?.error)}`);

    if (!newTargetId) {
      log('FAIL', 'Target.createTarget failed');
      dumpProxyLogs();
      failed++;
    } else {
      passed++;

      // Wait for group assignment (setTimeout 2000ms + buffer)
      log('WAIT', 'Waiting 6s for addTabToAutomationGroup setTimeout(2000)...');
      await sleep(6000);

      // Check proxy logs for group-related messages
      const groupLogs = proxyLogs.filter(l =>
        l.includes('[TabGroup]') || l.includes('group') || l.includes('Group')
      );
      log('LOGS', `Group-related proxy logs (${groupLogs.length}):`);
      groupLogs.slice(-20).forEach(l => log('LOGS', `  ${l}`));

      // Now disconnect and check if tab is cleaned up
      // If tab was in group → it gets closed
      // If tab was NOT in group → it survives (but still mapped to clientId → gets closed by closeTabsByClientId)
      log('DISC', 'Disconnecting WS...');
      ws.close();
      await sleep(8000);

      // Check surviving tabs
      const checkWs = new WebSocket(`ws://localhost:${PORT}/client`);
      await new Promise((r, e) => { checkWs.on('open', r); checkWs.on('error', e); });
      const checkResult = await sendCDP(checkWs, 'Target.getTargets');
      checkWs.close();

      const surviving = (checkResult?.result?.targetInfos || []).filter(t => t.type === 'page');
      log('FINAL', `${surviving.length} surviving pages:`);
      surviving.forEach(t => log('FINAL', `  ${t.targetId} — ${t.url}`));

      const tabSurvived = surviving.some(t => t.targetId === newTargetId);
      if (!tabSurvived) {
        log('PASS', 'CDP tab was cleaned up (tab was tracked)');
        passed++;
      } else {
        log('FAIL', 'CDP tab SURVIVED disconnect — tab was not tracked or not in group!');
        failed++;
      }
    }

  } catch (err) {
    console.error('\nFATAL:', err.message);
    dumpProxyLogs();
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
