const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = process.env.CHROME_PATH || '/Users/xuyingzhou/Project/temporary/pi-agent-chat/chrome/mac_arm-149.0.7827.54/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXTENSION_SRC = path.join(__dirname, '..', '..', 'extension-new');
const PROXY_SERVER = path.join(__dirname, '..', '..', 'server', 'proxy-server.js');
const CONFIG_FILE = path.join(EXTENSION_SRC, 'utils', 'config.js');

let _proxyProcess = null;
let _chromeProcess = null;
let _requestId = 0;
let _originalConfig = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendCDP(ws, method, params = {}) {
  const id = ++_requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout [${id}]: ${method}`));
    }, 15000);
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
    ws.send(JSON.stringify({ id, method, params }));
  });
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

function collectCDPEvents(ws, methodFilter, duration = 5000) {
  return new Promise((resolve) => {
    const events = [];
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method && (!methodFilter || methodFilter.includes(msg.method))) {
          events.push(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(events);
    }, duration);
  });
}

async function startProxy(port) {
  _proxyProcess = spawn('node', [PROXY_SERVER], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'warn' },
    stdio: 'pipe'
  });
  _proxyProcess.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) log('PROXY-ERR', s.substring(0, 120));
  });

  const start = Date.now();
  while (Date.now() - start < 10000) {
    try { await httpGet(port, '/json/version'); return true; } catch { await sleep(300); }
  }
  return false;
}

async function patchExtension(port) {
  _originalConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
  fs.writeFileSync(CONFIG_FILE,
    _originalConfig.replace(
      /WS_URL:\s*'ws:\/\/localhost:\d+\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

async function startBrowser(extraArgs = []) {
  const profile = `/tmp/cdp-e2e-test-${Date.now()}`;
  _chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_SRC}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank',
    ...extraArgs
  ], { detached: true, stdio: 'ignore' });
  _chromeProcess._profile = profile;
}

async function waitForExtension(port, maxWait = 90000) {
  await sleep(8000);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const list = await httpGet(port, '/json/list');
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) {
        await sleep(1000);
        return true;
      }
    } catch {}
    await sleep(2000);
  }
  return false;
}

function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function cleanup() {
  log('CLEANUP', 'Cleaning up...');
  if (_chromeProcess) {
    try { process.kill(-_chromeProcess.pid); } catch {}
    if (_chromeProcess._profile) {
      try { fs.rmSync(_chromeProcess._profile, { recursive: true, force: true }); } catch {}
    }
    _chromeProcess = null;
  }
  if (_proxyProcess) {
    try { _proxyProcess.kill('SIGINT'); } catch {}
    _proxyProcess = null;
  }
  if (_originalConfig) {
    try { fs.writeFileSync(CONFIG_FILE, _originalConfig); } catch {}
    _originalConfig = null;
  }
  await sleep(1000);
}

module.exports = {
  log, sleep, sendCDP, httpGet, collectCDPEvents,
  startProxy, patchExtension, startBrowser, waitForExtension,
  connectCDP, cleanup,
  CHROME_PATH, EXTENSION_SRC
};
