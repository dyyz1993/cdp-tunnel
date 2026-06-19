#!/usr/bin/env node
'use strict';

/**
 * 端口隔离测试：不同 create 端口的 client 互不可见对方的 tab
 * v3.0 端口池核心隔离验证
 *
 * 架构：
 *   PLUGIN_PORT (如 19421) ← 扩展连接的 plugin 端口
 *   CREATE_A   (如 19422)  ← create 会话 1（pool port 0）
 *   CREATE_B   (如 19423)  ← create 会话 2（pool port 1）
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PLUGIN_PORT = 20000 + Math.floor(Math.random() * 10000);
const CREATE_A = PLUGIN_PORT + 1;    // pool port 0
const CREATE_B = PLUGIN_PORT + 2;    // pool port 1
const TAKEOVER_PORT = PLUGIN_PORT + 10; // 避开端口池

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

let _id = 1;
function makeClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const pending = new Map();
  let clientId = 1;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = clientId++;
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout: ' + method)); } }, 20000);
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      ws.send(JSON.stringify(o));
    });
  }
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

let proxyProc, chromeProc, configOriginal;
let passed = 0, failed = 0;
function record(label, pass, detail) {
  if (pass) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log(`\n[Port Isolation] plugin=${PLUGIN_PORT} A=${CREATE_A} B=${CREATE_B}`);

  try {
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: {
        ...process.env,
        PORT: String(PLUGIN_PORT),
        TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(CREATE_A),
        POOL_SIZE: '2',
        POOL_TAKEOVER_PORT: String(TAKEOVER_PORT),
        LOG_LEVEL: 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });

    for (let i = 0; i < 20; i++) {
      try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); }
    }

    const profile = `/tmp/cdp-port-iso-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    await sleep(4000);

    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try {
        const ver = await httpGet(PLUGIN_PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension connected');

    // 确认 create 端口活着
    const verA = await httpGet(CREATE_A, '/json/version');
    const verB = await httpGet(CREATE_B, '/json/version');
    record('CREATE_A /json/version', verA && verA.webSocketDebuggerUrl, `ws=${verA?.webSocketDebuggerUrl?.slice(0,40)}`);
    record('CREATE_B /json/version', verB && verB.webSocketDebuggerUrl, `ws=${verB?.webSocketDebuggerUrl?.slice(0,40)}`);

    // Client A 连 CREATE_A
    const clientA = makeClient(CREATE_A);
    await clientA.open;
    const ctA = await clientA.cdp('Target.createTarget', { url: 'about:blank' }).catch(e => ({ error: e.message }));
    record('Client A createTarget', !!ctA?.targetId, ctA?.error || `targetId=${ctA?.targetId?.slice(0,8)}`);

    // Client B 连 CREATE_B
    const clientB = makeClient(CREATE_B);
    await clientB.open;
    const ctB = await clientB.cdp('Target.createTarget', { url: 'about:blank' }).catch(e => ({ error: e.message }));
    record('Client B createTarget', !!ctB?.targetId, ctB?.error || `targetId=${ctB?.targetId?.slice(0,8)}`);

    if (ctA?.targetId && ctB?.targetId) {
      // 核心隔离断言
      const listA = await httpGet(CREATE_A, '/json/list');
      const listB = await httpGet(CREATE_B, '/json/list');
      const aHasB = (listA || []).some(t => t.id === ctB.targetId);
      const bHasA = (listB || []).some(t => t.id === ctA.targetId);
      record('A /json/list 不含 B 的 tab', !aHasB, aHasB ? 'FOUND B target!' : 'isolated');
      record('B /json/list 不含 A 的 tab', !bHasA, bHasA ? 'FOUND A target!' : 'isolated');
    }

    clientA.ws.close();
    clientB.ws.close();
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    failed++;
  } finally {
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
