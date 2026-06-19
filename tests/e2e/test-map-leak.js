#!/usr/bin/env node
'use strict';

/**
 * 快速连/断脚本：验证映射表泄漏
 * 连 N 次 client，每次做完整 open 序列（setAutoAttach → createTarget → attach → close → disconnect）
 * 每 50 次 dump /debug/maps 看 Map size 是否增长
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

const PORT = parseInt(process.env.PORT || '9231', 10);
const ITERATIONS = parseInt(process.env.ITERATIONS || '500', 10);

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

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this._id = 1;
    this._pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  sendAwait(method, params = {}, sessionId, timeout = 15000) {
    const id = this._id++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('Timeout: ' + method)); } }, timeout);
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      this.ws.send(JSON.stringify(o));
    });
  }
}

// 完整的连/断周期
async function oneCycle(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  const client = new CdpClient(ws);

  try {
    await client.sendAwait('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const ct = await client.sendAwait('Target.createTarget', { url: 'about:blank' });
    if (ct?.targetId) {
      await client.sendAwait('Target.attachToTarget', { targetId: ct.targetId, flatten: true }).catch(() => {});
    }
    // 不 close target，模拟"断开连接"场景——cleanupClient 应该清理
  } catch (e) {
    // 忽略错误，继续断开
  } finally {
    ws.close();
  }
}

let proxyProc, chromeProc, configOriginal;

(async () => {
  console.log(`\n=== 映射表泄漏测试: ${ITERATIONS} 次连/断 ===\n`);

  try {
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
    for (let i = 0; i < 20; i++) {
      try { await httpGet(PORT, '/json/version'); break; } catch { await sleep(500); }
    }

    const profile = `/tmp/cdp-leak-${Date.now()}`;
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
        const ver = await httpGet(PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension connected\n');

    // 初始 baseline
    const baseline = await httpGet(PORT, '/debug/maps');
    console.log('Baseline:', JSON.stringify(baseline));
    console.log('');

    console.log('Iter  | targetMap | sessionMap | ctxMap | pendingAtt | pendingCre | globalReq');
    console.log('------|-----------|------------|--------|------------|------------|----------');

    const samples = [{ iter: 0, ...baseline }];

    for (let i = 1; i <= ITERATIONS; i++) {
      await oneCycle(PORT);
      await sleep(20); // 快速但不暴力

      if (i % 50 === 0) {
        const maps = await httpGet(PORT, '/debug/maps');
        samples.push({ iter: i, ...maps });
        console.log(
          `${String(i).padStart(5)} |` +
          `${String(maps.targetIdToClientId).padStart(10)}|` +
          `${String(maps.sessionToClientId).padStart(12)}|` +
          `${String(maps.browserContextToClientId).padStart(7)}|` +
          `${String(maps.pendingAttachedEvents).padStart(12)}|` +
          `${String(maps.pendingTargetCreatedEvents).padStart(12)}|` +
          `${String(maps.globalRequestIdMap).padStart(10)}`
        );
      }
    }

    // 分析趋势
    console.log('\n=== 泄漏分析 ===\n');
    const leaks = [];
    const keys = ['targetIdToClientId', 'sessionToClientId', 'browserContextToClientId',
                  'pendingAttachedEvents', 'pendingTargetCreatedEvents', 'globalRequestIdMap'];

    for (const key of keys) {
      const first = samples[0][key] || 0;
      const last = samples[samples.length - 1][key] || 0;
      const delta = last - first;
      const leaking = last > first + 2; // 允许 2 以内的波动
      const status = leaking ? '🔴 泄漏' : '✅ 稳定';
      console.log(`  ${key.padEnd(30)} ${first} → ${last} (${delta > 0 ? '+' : ''}${delta}) ${status}`);
      if (leaking) leaks.push({ key, first, last, delta });
    }

    if (leaks.length > 0) {
      console.log(`\n⚠️ 发现 ${leaks.length} 个泄漏的 Map！`);
      leaks.forEach(l => console.log(`  - ${l.key}: ${l.first} → ${l.last} (+${l.delta} after ${ITERATIONS} cycles)`));
    } else {
      console.log(`\n✅ 所有映射表在 ${ITERATIONS} 次连/断后保持稳定，无明显泄漏。`);
    }

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
  } finally {
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  process.exit(0);
})();
