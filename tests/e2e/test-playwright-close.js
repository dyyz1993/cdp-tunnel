#!/usr/bin/env node
'use strict';

/**
 * Test: Does Playwright browser.close() hang when using CDP Tunnel?
 *
 * Uses Playwright's chromium.connectOverCDP() (NOT raw CDP WebSocket)
 * to connect through the proxy, then measures browser.close() duration.
 * If it hangs > TIMEOUT_MS, the hang is confirmed.
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19222;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

const TIMEOUT_MS = 15_000;

let proxyProcess = null;
let chromeProcess = null;
let originalConfig = null;

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
  let reqId = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const id = ++reqId;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 5000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      });
      ws.close();
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
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

async function runTest() {
  console.log('=== Playwright browser.close() hang test ===\n');

  try {
    patchConfig(PROXY_PORT);
    log('SETUP', 'Patched extension config');

    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stdout?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('PROXY', l));
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('PROXY-ERR', l));
    });
    log('SETUP', `Proxy started (PID: ${proxyProcess.pid})`);

    const userDataDir = `/tmp/pw-close-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      '--enable-logging',
      '--v=1',
      'about:blank'
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    chromeProcess.stdout?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('CHROME', l));
    });
    chromeProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('CHROME-ERR', l));
    });
    chromeProcess._profile = userDataDir;
    log('SETUP', `Chrome started (PID: ${chromeProcess.pid})`);

    chromeProcess.on('exit', (code, signal) => {
      log('CHROME', `Chrome exited with code=${code} signal=${signal}`);
    });

    log('SETUP', 'Waiting for proxy...');
    if (!await waitForProxy(PROXY_PORT)) throw new Error('Proxy did not become ready');
    log('SETUP', 'Proxy is ready');

    await sleep(3000);
    try {
      chromeProcess.ref();
      const stillAlive = chromeProcess.exitCode === null;
      log('SETUP', `Chrome alive check: ${stillAlive} (exitCode=${chromeProcess.exitCode})`);
      chromeProcess.unref();
    } catch {}

    log('SETUP', 'Waiting for extension to connect...');
    if (!await waitForExtension(PROXY_PORT)) throw new Error('Extension did not connect');
    log('SETUP', 'Extension connected');

    await sleep(3000);

    log('PW', 'Connecting Playwright via CDP...');
    const browser = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`);
    log('PW', `Connected! Contexts: ${browser.contexts().length}`);

    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto('about:blank');
    log('PW', `Opened page: ${page.url()}`);

    await sleep(3000);

    log('PW', 'Calling browser.close()...');
    const closeStart = Date.now();

    let closeSucceeded = false;
    let closeError = null;

    const closePromise = browser.close();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`browser.close() TIMEOUT after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    );

    try {
      await Promise.race([closePromise, timeoutPromise]);
      closeSucceeded = true;
    } catch (err) {
      closeError = err;
    }

    const closeDuration = Date.now() - closeStart;

    console.log('\n=== RESULT ===');
    if (closeSucceeded) {
      console.log(`✅ browser.close() completed in ${closeDuration}ms`);
      console.log('   No hang detected.');
    } else {
      console.log(`❌ browser.close() FAILED after ${closeDuration}ms`);
      console.log(`   Error: ${closeError?.message}`);
      if (closeDuration >= TIMEOUT_MS - 100) {
        console.log('   ⚠️  HANG DETECTED! browser.close() did not return within timeout.');
        console.log('   This confirms the CDP Bridge may not respond to Browser.close.');
      }
    }
    console.log('==============\n');

    cleanup();

    try {
      if (chromeProcess && chromeProcess._profile) {
        fs.rmSync(chromeProcess._profile, { recursive: true, force: true });
      }
    } catch {}

    process.exit(closeSucceeded ? 0 : 1);

  } catch (err) {
    console.error('Test error:', err);
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
runTest();
