#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PATH = fs.existsSync(CHROMIUM) ? CHROMIUM : fs.existsSync(CHROME) ? CHROME : null;
const EXTENSION_SRC = path.resolve(__dirname, '../../extension-new');
const PROXY_SERVER = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_FILE = path.join(EXTENSION_SRC, 'utils', 'config.js');
const USER_DATA_DIR = `/tmp/cdp-compare-${Date.now()}`;

const CDP_DIRECT_PORT = 19222;
const CDP_TUNNEL_PORT = 19221;

if (!CHROME_PATH) {
  console.error('Chrome/Chromium not found');
  process.exit(1);
}

let originalConfig = null;
let proxyProcess = null;
let chromeProcess = null;
let _reqId = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function connectWS(urlStr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(urlStr);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 10000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

function sendCDP(ws, method, params = {}) {
  const id = ++_reqId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
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

function collectEvents(ws, methodFilter, duration) {
  return new Promise((resolve) => {
    const events = [];
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method && methodFilter.includes(msg.method)) {
          events.push({ method: msg.method, params: msg.params });
        }
      } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(events); }, duration);
  });
}

async function setup() {
  log('SETUP', `Chrome: ${CHROME_PATH}`);

  if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true });

  try { execSync(`lsof -ti :${CDP_DIRECT_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  try { execSync(`lsof -ti :${CDP_TUNNEL_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  await sleep(500);

  originalConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
  fs.writeFileSync(CONFIG_FILE,
    originalConfig.replace(
      /WS_URL:\s*'ws:\/\/localhost:\d+\/plugin'/,
      `WS_URL: 'ws://localhost:${CDP_TUNNEL_PORT}/plugin'`
    )
  );

  proxyProcess = spawn('node', [PROXY_SERVER], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(CDP_TUNNEL_PORT), LOG_LEVEL: 'warn' }
  });
  proxyProcess.stdout.on('data', () => {});
  proxyProcess.stderr.on('data', () => {});

  for (let i = 0; i < 30; i++) {
    try { await httpGet(`http://localhost:${CDP_TUNNEL_PORT}/json/version`); break; } catch { await sleep(500); }
  }
  log('SETUP', 'Proxy server started');

  chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_DIRECT_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    `--load-extension=${EXTENSION_SRC}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'about:blank'
  ], { detached: false, stdio: 'ignore' });

  log('SETUP', 'Waiting for Chrome + Extension...');
  await sleep(6000);

  for (let i = 0; i < 30; i++) {
    try {
      const version = await httpGet(`http://localhost:${CDP_DIRECT_PORT}/json/version`);
      if (version && version.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(1000);
  }
  log('SETUP', 'Chrome CDP direct ready');

  for (let i = 0; i < 30; i++) {
    try {
      const ws = await connectWS(`ws://localhost:${CDP_TUNNEL_PORT}/client`);
      const r = await Promise.race([sendCDP(ws, 'Target.getTargets'), sleep(5000).then(() => ({ error: true }))]);
      ws.close();
      _reqId = 0;
      if (r && r.result && r.result.targetInfos) break;
    } catch {}
    await sleep(2000);
  }
  log('SETUP', 'Extension connected to tunnel');
}

async function teardown() {
  log('TEARDOWN', 'Cleaning up...');
  try { if (proxyProcess) proxyProcess.kill('SIGKILL'); } catch {}
  try { if (chromeProcess) chromeProcess.kill('SIGKILL'); } catch {}
  try { execSync(`lsof -ti :${CDP_DIRECT_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  try { execSync(`lsof -ti :${CDP_TUNNEL_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  if (originalConfig) {
    try { fs.writeFileSync(CONFIG_FILE, originalConfig); } catch {}
    originalConfig = null;
  }
  try { fs.rmSync(USER_DATA_DIR, { recursive: true }); } catch {}
}

const ctx = {
  httpGet,
  connectWS,
  sendCDP,
  collectEvents,
  sleep,
  log,
  chromium,
  directPort: CDP_DIRECT_PORT,
  tunnelPort: CDP_TUNNEL_PORT,
};

function printReport(results) {
  console.log('\n');
  console.log('═'.repeat(80));
  console.log('  CDP 对比测试报告: 标准 CDP (port ' + CDP_DIRECT_PORT + ') vs cdp-tunnel (port ' + CDP_TUNNEL_PORT + ')');
  console.log('═'.repeat(80));

  const groups = {};
  for (const r of results) {
    const key = r.caseName || r.name || 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  let totalChecks = results.length;
  let matchCount = results.filter(r => r.match).length;
  let diffCount = results.filter(r => !r.match).length;

  for (const [caseName, caseResults] of Object.entries(groups)) {
    console.log(`\n┌─ ${caseName} ${'─'.repeat(Math.max(0, 70 - caseName.length))}`);
    for (const r of caseResults) {
      const icon = r.match ? '✓' : '✗';
      console.log(`│ ${icon} ${r.details || r.name}`);
      const directStr = typeof r.direct === 'string' ? r.direct : JSON.stringify(r.direct);
      const tunnelStr = typeof r.tunnel === 'string' ? r.tunnel : JSON.stringify(r.tunnel);
      console.log(`│   标准 CDP: ${directStr.length > 200 ? directStr.substring(0, 200) + '...' : directStr}`);
      console.log(`│   Tunnel:   ${tunnelStr.length > 200 ? tunnelStr.substring(0, 200) + '...' : tunnelStr}`);
    }
    console.log(`└${'─'.repeat(78)}`);
  }

  console.log('\n');
  console.log('═'.repeat(80));
  console.log(`  总计: ${totalChecks} 项 | 一致: ${matchCount} | 差异: ${diffCount}`);
  if (diffCount > 0) {
    console.log('\n  差异明细:');
    for (const r of results) {
      if (!r.match) {
        console.log(`    ✗ ${r.caseName || ''} - ${r.details || r.name}`);
      }
    }
  }
  console.log('═'.repeat(80));

  return diffCount;
}

async function main() {
  try {
    await setup();
    log('INFO', 'Waiting for pages to settle...');
    await sleep(3000);

    const cases = require('./cases');
    const allResults = [];

    for (const [caseName, caseFn] of Object.entries(cases)) {
      log('CASE', `▶ ${caseName}`);
      try {
        const results = await caseFn(ctx);
        if (Array.isArray(results)) {
          for (const r of results) {
            r.caseName = r.caseName || caseName;
            allResults.push(r);
          }
        } else if (results) {
          results.caseName = results.caseName || caseName;
          allResults.push(results);
        }
      } catch (e) {
        log('ERROR', `  ${caseName}: ${e.message}`);
        allResults.push({
          caseName,
          name: caseName,
          direct: null,
          tunnel: null,
          match: false,
          details: `FATAL: ${e.message}`
        });
      }
    }

    const diffCount = printReport(allResults);
    process.exit(diffCount > 0 ? 1 : 0);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(2);
  } finally {
    await teardown();
  }
}

main();
