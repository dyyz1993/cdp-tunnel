#!/usr/bin/env node
'use strict';

/**
 * 版本校验测试
 *
 * 验证：
 * 1. 版本一致 → 连接允许
 * 2. 版本不一致 + STRICT_VERSION=true → 拒绝（4002）
 * 3. 版本不一致 + 不开 STRICT_VERSION → 允许（警告但不拒绝）
 *
 * 用裸 WebSocket 模拟扩展，手动发 plugin-hello 带不同版本号。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const PKG = require(path.resolve(__dirname, '../../package.json'));
const SERVER_VERSION = PKG.version;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitForPort(port, timeout = 15000) {
  const start = Date.now();
  return new Promise(resolve => {
    const check = () => {
      http.get(`http://127.0.0.1:${port}/json/version`, res => { res.resume(); resolve(true); })
        .on('error', () => { Date.now() - start > timeout ? resolve(false) : setTimeout(check, 500); });
    };
    check();
  });
}

// 模拟扩展连接：连 /plugin，发 plugin-hello 带指定版本，等结果
function simulateExtension(port, version, extraEnv) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(r); } };
    const ws = new WebSocket(`ws://localhost:${port}/plugin`);
    ws.on('open', () => {
      // 发 plugin-hello 带版本号
      ws.send(JSON.stringify({ type: 'plugin-hello', version: version }));
      // 等 2s 看会不会被踢
      setTimeout(() => done({ accepted: true }), 2000);
    });
    ws.on('close', code => done({ accepted: false, code }));
    ws.on('error', e => done({ accepted: false, code: 'error', err: e.message.slice(0, 60) }));
    setTimeout(() => done({ accepted: 'timeout' }), 5000);
  });
}

function startProxy(port, env) {
  return spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(port), POOL_SIZE: '0', LOG_LEVEL: 'warn', ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

(async () => {
  let passed = 0, failed = 0;
  function ok(label, cond, extra) {
    cond ? (passed++, console.log(`[PASS] ${label}`)) : (failed++, console.log(`[FAIL] ${label}${extra ? ' → ' + extra : ''}`));
  }

  try {
    console.log(`\n=== 版本校验测试（server=${SERVER_VERSION}）===\n`);

    // Test 1: 版本一致 → 允许
    {
      const PORT = 29710;
      console.log('[Test 1] 版本一致 → 应允许');
      const proxy = startProxy(PORT, { STRICT_VERSION: 'true' });
      proxy.stdout.on('data', () => {}); proxy.stderr.on('data', () => {});
      if (await waitForPort(PORT)) {
        const r = await simulateExtension(PORT, SERVER_VERSION);
        ok('版本一致允许连接', r.accepted === true, `accepted=${r.accepted} code=${r.code}`);
      } else { ok('版本一致: proxy 启动', false); }
      proxy.kill('SIGTERM'); await sleep(500);
    }

    // Test 2: 版本不一致 + STRICT_VERSION=true → 拒绝(4002)
    {
      const PORT = 29711;
      console.log('\n[Test 2] 版本不一致 + STRICT_VERSION=true → 应拒绝(4002)');
      const proxy = startProxy(PORT, { STRICT_VERSION: 'true' });
      proxy.stdout.on('data', () => {}); proxy.stderr.on('data', () => {});
      if (await waitForPort(PORT)) {
        const r = await simulateExtension(PORT, '0.0.0-mock-old');
        ok('版本不一致被拒(4002)', r.accepted === false && r.code === 4002, `accepted=${r.accepted} code=${r.code}`);
      } else { ok('STRICT 拒绝: proxy 启动', false); }
      proxy.kill('SIGTERM'); await sleep(500);
    }

    // Test 3: 版本不一致 + 不开 STRICT_VERSION → 允许(警告)
    {
      const PORT = 29712;
      console.log('\n[Test 3] 版本不一致 + 不开 STRICT → 应允许');
      const proxy = startProxy(PORT, {});
      proxy.stdout.on('data', () => {}); proxy.stderr.on('data', () => {});
      if (await waitForPort(PORT)) {
        const r = await simulateExtension(PORT, '0.0.0-mock-old');
        ok('版本不一致但允许(无 STRICT)', r.accepted === true, `accepted=${r.accepted} code=${r.code}`);
      } else { ok('无 STRICT 允许: proxy 启动', false); }
      proxy.kill('SIGTERM'); await sleep(500);
    }

  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`); failed++;
  }
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
