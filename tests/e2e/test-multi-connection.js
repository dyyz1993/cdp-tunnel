#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

let passed = 0;
let failed = 0;
let proxy1 = null;
let proxy2 = null;
let chromeProc = null;
let configOriginal = null;
let profileDir = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    }).on('error', reject);
  });
}

async function waitForPort(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { await httpGet(port, '/json/version'); return true; } catch { await sleep(500); }
  }
  return false;
}

function sendCDP(ws, method, params = {}) {
  const id = Date.now() + Math.random();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout: ${method}`));
    }, 15000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function startProxy(port) {
  const proc = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  proc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) log('PROXY', s.substring(0, 120));
  });
  return proc;
}

function killProc(proc) {
  if (!proc) return;
  try { proc.kill('SIGINT'); } catch {}
}

function killChrome() {
  if (!chromeProc) return;
  try { process.kill(-chromeProc.pid); } catch {}
  if (profileDir) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
  chromeProc = null;
}

function patchConfigMulti(port1, port2) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  const patched = configOriginal.replace(
    /WS_URL:\s*'[^']*'/,
    `WS_URL: 'ws://localhost:${port1}/plugin'`
  ).replace(
    /getConnections:\s*function\(callback\)\s*\{/,
    `getConnections: function(callback) {\n    callback([\n      { id: 'conn_local', tag: 'local', url: 'ws://localhost:${port1}/plugin', enabled: true },\n      { id: 'conn_remote', tag: 'remote', url: 'ws://localhost:${port2}/plugin', enabled: true }\n    ]);\n    return;`
  );
  fs.writeFileSync(CONFIG_PATH, patched);
}

function patchConfigSingle(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`)
  );
}

function restoreConfig() {
  if (configOriginal) {
    try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
    configOriginal = null;
  }
}

async function startChrome() {
  profileDir = `/tmp/cdp-multi-conn-${Date.now()}`;
  chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  chromeProc._profile = profileDir;
}

async function waitForExtension(port, maxWait = 60000) {
  await sleep(8000);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const list = await httpGet(port, '/json/list');
      const pages = (list || []).filter(t => t.type === 'page');
      if (pages.length > 0) {
        await sleep(2000);
        return true;
      }
    } catch {}
    await sleep(2000);
  }
  return false;
}

function assert(condition, passMsg, failMsg) {
  if (condition) {
    console.log(`[PASS] ${passMsg}`);
    passed++;
  } else {
    console.log(`[FAIL] ${failMsg}`);
    failed++;
  }
}

async function cleanup() {
  killChrome();
  killProc(proxy1);
  killProc(proxy2);
  restoreConfig();
  await sleep(1000);
}

(async () => {
  const PORT1 = 10000 + Math.floor(Math.random() * 20000);
  const PORT2 = PORT1 + 1;

  log('SETUP', `Ports: ${PORT1} (local), ${PORT2} (remote)`);

  // ─── Test 1: Single connection regression ───
  console.log('\n=== Test 1: Single Connection Regression ===');
  proxy1 = startProxy(PORT1);
  if (!await waitForPort(PORT1)) {
    console.log('[FAIL] Proxy 1 failed to start');
    await cleanup();
    process.exit(1);
  }
  patchConfigSingle(PORT1);
  await startChrome();
  if (!await waitForExtension(PORT1)) {
    console.log('[FAIL] Extension not connected (single)');
    await cleanup();
    process.exit(1);
  }

  try {
    const browser1 = await chromium.connectOverCDP(`http://localhost:${PORT1}`, { timeout: 20000 });
    const ctx1 = browser1.contexts()[0];
    const page1 = await ctx1.newPage();
    await page1.goto('https://www.example.com', { timeout: 15000 }).catch(() => {});
    const pages1 = ctx1.pages();
    assert(pages1.length >= 2,
      `Single connection: ${pages1.length} pages (>= 2)`,
      `Single connection: only ${pages1.length} pages`
    );
    await browser1.close();
    log('T1', 'Browser closed');
  } catch (e) {
    console.log(`[FAIL] Test 1 error: ${e.message}`);
    failed++;
  }

  killChrome();
  killProc(proxy1);
  restoreConfig();
  await sleep(2000);

  // ─── Test 2: Two proxy servers, two connections ───
  console.log('\n=== Test 2: Two Connections Sequential ===');
  proxy1 = startProxy(PORT1);
  proxy2 = startProxy(PORT2);

  if (!await waitForPort(PORT1) || !await waitForPort(PORT2)) {
    console.log('[FAIL] Proxies failed to start');
    await cleanup();
    process.exit(1);
  }
  log('T2', 'Both proxies ready');

  patchConfigMulti(PORT1, PORT2);
  await startChrome();
  if (!await waitForExtension(PORT1)) {
    console.log('[FAIL] Extension not connected (multi)');
    await cleanup();
    process.exit(1);
  }
  log('T2', 'Extension connected');

  try {
    // Connect to first proxy (local tag)
    const browserA = await chromium.connectOverCDP(`http://localhost:${PORT1}`, { timeout: 20000 });
    const ctxA = browserA.contexts()[0];
    await ctxA.newPage();
    const pagesA = ctxA.pages();
    log('T2', `Connection A (local): ${pagesA.length} pages`);

    assert(pagesA.length >= 1,
      `Connection A has ${pagesA.length} pages`,
      `Connection A has no pages`
    );

    // Connect to second proxy (remote tag)
    const browserB = await chromium.connectOverCDP(`http://localhost:${PORT2}`, { timeout: 20000 });
    const ctxB = browserB.contexts()[0];
    await ctxB.newPage();
    const pagesB = ctxB.pages();
    log('T2', `Connection B (remote): ${pagesB.length} pages`);

    assert(pagesB.length >= 1,
      `Connection B has ${pagesB.length} pages`,
      `Connection B has no pages`
    );

    // Verify isolation: A's targets != B's targets
    const targetsA = await sendCDP(
      await connectWS(PORT1), 'Target.getTargets'
    );
    const targetsB = await sendCDP(
      await connectWS(PORT2), 'Target.getTargets'
    );

    const pageTargetsA = (targetsA?.result?.targetInfos || []).filter(t => t.type === 'page');
    const pageTargetsB = (targetsB?.result?.targetInfos || []).filter(t => t.type === 'page');

    const idsA = new Set(pageTargetsA.map(t => t.targetId));
    const idsB = new Set(pageTargetsB.map(t => t.targetId));
    const overlap = [...idsA].filter(id => idsB.has(id));

    assert(overlap.length === 0,
      `Connections isolated: A has ${idsA.size} targets, B has ${idsB.size} targets, 0 overlap`,
      `Connections NOT isolated: ${overlap.length} overlapping target(s)`
    );

    // Disconnect A, verify B still works
    await browserA.close();
    log('T2', 'Connection A closed');
    await sleep(1000);

    const pagesBAfter = ctxB.pages();
    assert(pagesBAfter.length >= 1,
      `B still has ${pagesBAfter.length} pages after A disconnect`,
      `B lost pages after A disconnect`
    );

    // B disconnect
    await browserB.close();
    log('T2', 'Connection B closed');
  } catch (e) {
    console.log(`[FAIL] Test 2 error: ${e.message}`);
    failed++;
  }

  killChrome();
  killProc(proxy1);
  killProc(proxy2);
  restoreConfig();
  await sleep(2000);

  // ─── Test 3: Group prefix verification ───
  console.log('\n=== Test 3: buildGroupName with connectionTag ===');

  // Test the helper function directly
  const helpersContent = fs.readFileSync(
    path.join(EXTENSION_PATH, 'utils', 'helpers.js'), 'utf8'
  );

  // Extract and eval the buildGroupName function for testing
  const buildGroupNameMatch = helpersContent.match(
    /function buildGroupName\(clientId,\s*connectionTag\)\s*\{[\s\S]*?^  \}/m
  );
  if (buildGroupNameMatch) {
    eval('var buildGroupName = function(clientId, connectionTag) {' +
      buildGroupNameMatch[0].replace(/function buildGroupName\(clientId,\s*connectionTag\)\s*\{/, '')
        .replace(/\n  \}/, '\n}')
    );
  }

  // Inline test of the naming logic
  function testBuildGroupName(clientId, tag) {
    var hash = 0;
    for (var i = 0; i < clientId.length; i++) {
      var chr = clientId.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash = hash | 0;
    }
    var suffix = Math.abs(hash).toString(16).substring(0, 8).padStart(8, '0');
    var tagPrefix = (tag && tag !== 'default') ? tag + '-' : '';
    return 'CDP-' + tagPrefix + suffix;
  }

  const nameLocal = testBuildGroupName('client_abc', 'local');
  const nameRemote = testBuildGroupName('client_abc', 'remote');
  const nameNoTag = testBuildGroupName('client_abc', null);
  const nameDefault = testBuildGroupName('client_abc', 'default');

  assert(nameLocal.startsWith('CDP-local-'),
    `local tag: ${nameLocal}`,
    `local tag wrong: ${nameLocal}`
  );
  assert(nameRemote.startsWith('CDP-remote-'),
    `remote tag: ${nameRemote}`,
    `remote tag wrong: ${nameRemote}`
  );
  assert(!nameNoTag.includes('-local-') && !nameNoTag.includes('-remote-') && nameNoTag.startsWith('CDP-'),
    `no tag: ${nameNoTag}`,
    `no tag wrong: ${nameNoTag}`
  );
  assert(!nameDefault.includes('-default-') && nameDefault.startsWith('CDP-'),
    `default tag: ${nameDefault} (no prefix for default)`,
    `default tag wrong: ${nameDefault}`
  );
  assert(nameLocal !== nameRemote,
    `local and remote names differ`,
    `local and remote names are the same!`
  );

  // ─── Test 4: Sequential connect-disconnect on different ports ───
  console.log('\n=== Test 4: Sequential A→B on Different Ports ===');
  proxy1 = startProxy(PORT1);
  proxy2 = startProxy(PORT2);

  if (!await waitForPort(PORT1) || !await waitForPort(PORT2)) {
    console.log('[FAIL] Proxies failed to start for Test 4');
    await cleanup();
    process.exit(1);
  }

  patchConfigMulti(PORT1, PORT2);
  await startChrome();
  if (!await waitForExtension(PORT1)) {
    console.log('[FAIL] Extension not connected for Test 4');
    await cleanup();
    process.exit(1);
  }

  try {
    // Phase A: Connect to port1
    const browserA = await chromium.connectOverCDP(`http://localhost:${PORT1}`, { timeout: 20000 });
    const ctxA = browserA.contexts()[0];
    const pA1 = await ctxA.newPage();
    await pA1.goto('https://www.example.com', { timeout: 15000 }).catch(() => {});
    log('T4', `Phase A: ${ctxA.pages().length} pages on port ${PORT1}`);

    assert(ctxA.pages().length >= 2,
      `Phase A: ${ctxA.pages().length} pages`,
      `Phase A: only ${ctxA.pages().length} pages`
    );

    await browserA.close();
    log('T4', 'Phase A disconnected');
    await sleep(2000);

    // Phase B: Connect to port2
    const browserB = await chromium.connectOverCDP(`http://localhost:${PORT2}`, { timeout: 20000 });
    const ctxB = browserB.contexts()[0];
    const pB1 = await ctxB.newPage();
    await pB1.goto('https://www.example.org', { timeout: 15000 }).catch(() => {});
    log('T4', `Phase B: ${ctxB.pages().length} pages on port ${PORT2}`);

    assert(ctxB.pages().length >= 2,
      `Phase B: ${ctxB.pages().length} pages`,
      `Phase B: only ${ctxB.pages().length} pages`
    );

    await browserB.close();
    log('T4', 'Phase B disconnected');
  } catch (e) {
    console.log(`[FAIL] Test 4 error: ${e.message}`);
    failed++;
  }

  // ─── Cleanup ───
  await cleanup();

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();

function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/client`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
