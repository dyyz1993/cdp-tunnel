#!/usr/bin/env node
'use strict';

/**
 * Test: agent-browser CLI connects through CDP Tunnel
 *
 * Architecture:
 *   agent-browser --cdp <port>
 *        ↓
 *   CDP Tunnel proxy (port 19240)
 *        ↓
 *   Extension (in Chrome)
 *        ↓
 *   Chrome Browser
 *
 * Strategy:
 *   1. Start CDP Tunnel (proxy + Chrome with extension)
 *   2. Connect agent-browser once: `agent-browser --cdp 19240 --session cdp-tunnel-test`
 *   3. Run all commands reusing the session: `agent-browser --session cdp-tunnel-test <cmd>`
 *   4. This avoids reconnection overhead and tests real-world usage
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19240;
const SESSION_NAME = 'cdp-tunnel-e2e';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;
let chromeProfileDir = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    configOriginal.replace(
      /WS_URL:\s*'ws:\/\/localhost:9221\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (configOriginal) {
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    configOriginal = null;
  }
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 15000) {
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
        const timeout = setTimeout(() => {
          ws.off('message', handler);
          reject(new Error('timeout'));
        }, 5000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              resolve(msg.result);
            }
          } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      });

      ws.close();
      reqId = 0;

      if (result && result.targetInfos && result.targetInfos.length > 0) return true;
    } catch (e) {
      log('SETUP', `  Waiting for extension... (${e.message})`);
    }
    await sleep(3000);
  }
  return false;
}

function run(cmd, timeout = 30000) {
  try {
    const result = execSync(
      `agent-browser --session ${SESSION_NAME} ${cmd}`,
      { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return { ok: true, output: result.trim() };
  } catch (err) {
    return {
      ok: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message
    };
  }
}

function runWithCdp(cmd, timeout = 30000) {
  try {
    const result = execSync(
      `agent-browser --cdp ${PROXY_PORT} --session ${SESSION_NAME} ${cmd}`,
      { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return { ok: true, output: result.trim() };
  } catch (err) {
    return {
      ok: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message
    };
  }
}

function runJSON(cmd, timeout = 30000) {
  const result = run(`${cmd} --json`, timeout);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.output);
    return { ok: parsed.success !== false, data: parsed, output: result.output };
  } catch {
    return result;
  }
}

async function cleanup() {
  log('CLEANUP', 'Cleaning up...');
  try { execSync(`agent-browser kill --session ${SESSION_NAME}`, { timeout: 5000, stdio: 'pipe' }); } catch {}
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    chromeProcess = null;
  }
  if (chromeProfileDir) {
    try { fs.rmSync(chromeProfileDir, { recursive: true, force: true }); } catch {}
    chromeProfileDir = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
  await sleep(1000);
}

async function runTest() {
  console.log('=== Test: agent-browser through CDP Tunnel ===\n');
  let passed = 0;
  let failed = 0;
  const results = [];

  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    if (ok) { passed++; log('PASS', `✅ ${name}`); }
    else { failed++; log('FAIL', `❌ ${name}: ${detail}`); }
  }

  try {
    // Kill leftover sessions
    log('SETUP', 'Cleaning up old sessions...');
    try { execSync(`agent-browser kill --session ${SESSION_NAME}`, { timeout: 5000, stdio: 'pipe' }); } catch {}

    // === SETUP ===
    log('SETUP', 'Patching extension config...');
    patchConfig(PROXY_PORT);

    log('SETUP', `Starting proxy on port ${PROXY_PORT}...`);
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) log('PROXY', s.substring(0, 120));
    });

    if (!await waitForProxy(PROXY_PORT)) {
      throw new Error('Proxy failed to start');
    }
    log('SETUP', 'Proxy ready');

    log('SETUP', 'Starting Chrome with extension...');
    chromeProfileDir = `/tmp/ab-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${chromeProfileDir}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PROXY_PORT)) {
      throw new Error('Extension failed to connect');
    }
    log('SETUP', 'Extension connected — CDP Tunnel ready\n');

    // === CONNECT: establish agent-browser session via CDP Tunnel ===
    log('CONNECT', `Connecting agent-browser to CDP tunnel (port ${PROXY_PORT})...`);
    const connectResult = runWithCdp(`connect ${PROXY_PORT}`, 60000);
    if (!connectResult.ok) {
      log('CONNECT', `connect failed: ${connectResult.error}, retrying with get url...`);
      try {
        execSync(`agent-browser --cdp ${PROXY_PORT} --session ${SESSION_NAME} get url`, {
          timeout: 60000, encoding: 'utf8', stdio: 'pipe'
        });
      } catch {}
    }
    // Verify session is alive
    const checkSession = runJSON('get url', 20000);
    const connected = checkSession.ok && checkSession.data?.success !== false;
    record('agent-browser CDP connect', connected,
      connected ? `session ${SESSION_NAME} active` : connectResult.error || 'session not active');

    if (!connected) {
      throw new Error('Cannot establish agent-browser session via CDP Tunnel');
    }

    // === TEST 1: Open page ===
    log('TEST', '1. Open example.com...');
    const openResult = run('open https://example.com', 60000);
    await sleep(2000);
    record('open page', openResult.ok, openResult.ok ? 'navigated' : openResult.error);

    // === TEST 2: Get page title ===
    log('TEST', '2. Get page title...');
    const titleResult = runJSON('get title', 10000);
    const title = titleResult.data?.data?.title || titleResult.output;
    record(
      'get title',
      titleResult.ok && title && title.includes('Example'),
      titleResult.ok ? `"${title}"` : (titleResult.error || 'empty')
    );

    // === TEST 3: Get page URL ===
    log('TEST', '3. Get page URL...');
    const urlResult = runJSON('get url', 10000);
    const url = urlResult.data?.data?.url || urlResult.output;
    record(
      'get url',
      urlResult.ok && url && url.includes('example.com'),
      urlResult.ok ? url : (urlResult.error || 'empty')
    );

    // === TEST 4: Snapshot ===
    log('TEST', '4. Take accessibility snapshot...');
    const snapResult = run('snapshot -i', 15000);
    const refCount = snapResult.ok ? (snapResult.output.match(/ref=e\d+/g) || []).length : 0;
    record(
      'snapshot',
      snapResult.ok && snapResult.output.length > 10,
      snapResult.ok ? `${refCount} interactive elements` : snapResult.error
    );

    // === TEST 5: Open form page ===
    log('TEST', '5. Open local form page...');
    const formHtml = `<!DOCTYPE html><html><head><title>Test Form</title></head><body>
<form id="testForm">
  <input type="text" id="name" name="name" placeholder="Name" />
  <input type="email" id="email" name="email" placeholder="Email" />
  <button type="submit" id="submitBtn">Submit</button>
</form>
<div id="result">No submission yet</div>
<script>
document.getElementById('testForm').addEventListener('submit', function(e) {
  e.preventDefault();
  document.getElementById('result').textContent =
    'Submitted: ' + document.getElementById('name').value + ' / ' + document.getElementById('email').value;
});
</script>
</body></html>`;

    const formFile = path.join(os.tmpdir(), `ab-form-${Date.now()}.html`);
    fs.writeFileSync(formFile, formHtml);

    const formResult = run(`open file://${formFile}`, 60000);
    await sleep(1000);
    record('open form page', formResult.ok, formResult.ok ? 'opened' : formResult.error);

    // === TEST 6: Fill form input ===
    log('TEST', '6. Fill form input...');
    const fillResult = run('fill "#name" "Zhang San"', 10000);
    record('fill input', fillResult.ok, fillResult.ok ? 'filled' : fillResult.error);

    // === TEST 7: Get text content ===
    log('TEST', '7. Get text content...');
    const textResult = run('get text "#result"', 10000);
    record(
      'get text',
      textResult.ok && textResult.output.length > 0,
      textResult.ok ? `"${textResult.output.slice(0, 80)}"` : textResult.error
    );

    // === TEST 8: Screenshot ===
    log('TEST', '8. Take screenshot...');
    const ssPath = `/tmp/test-ab-screenshot-${Date.now()}.png`;
    const ssResult = run(`screenshot ${ssPath}`, 15000);
    const ssExists = fs.existsSync(ssPath);
    const ssSize = ssExists ? fs.statSync(ssPath).size : 0;
    record(
      'screenshot',
      ssResult.ok || ssExists,
      ssExists ? `${ssSize} bytes` : (ssResult.error || 'file missing')
    );

    // Cleanup temp files
    try { fs.unlinkSync(formFile); } catch {}
    try { if (ssExists) fs.unlinkSync(ssPath); } catch {}

    // === SUMMARY ===
    await cleanup();

    console.log('\n=== RESULTS ===');
    for (const r of results) {
      console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : ' — ' + r.detail}`);
    }
    console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);

    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    console.error('FATAL:', err.message);
    await cleanup();
    process.exit(1);
  }
}

runTest();
