#!/usr/bin/env node
'use strict';

/**
 * API Key 鉴权测试（REQUIRE_AUTH=true 模式）
 *
 * 验证：
 * 1. /client 不带 key → 被拒（4001）
 * 2. /client 带错误 key → 被拒（4001）
 * 3. 扩展带正确 key 连 /plugin → 成功
 * 4. 客户端带正确 key → createTarget + attach + evaluate 成功
 * 5. 不同 key 隔离（key B 无浏览器连接，应被拒）
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const KEY_MGR = path.resolve(__dirname, '../../server/saas/key-manager.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}
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

// 测试"应被拒"的连接：端口池是 open 后再 close，所以要等 close 事件拿 code
function expectReject(url) {
  return new Promise(resolve => {
    let settled = false;
    const ws = new WebSocket(url);
    const done = r => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(r); } };
    ws.on('close', code => done({ rejected: code === 4001, code }));
    ws.on('error', () => done({ rejected: false, code: 'error' }));
    ws.on('open', () => setTimeout(() => done({ rejected: false, code: null }), 3000));
    setTimeout(() => done({ rejected: false, code: 'timeout' }), 8000);
  });
}

// 从 key-manager 输出里提取 key
function createKey(name) {
  const out = execSync(`node ${KEY_MGR} create ${name}`, { encoding: 'utf8' });
  const m = out.match(/Key:\s*(cdp_\w+)/);
  return m ? m[1] : null;
}

(async () => {
  let passed = 0, failed = 0;
  const PORT = 29600 + Math.floor(Math.random() * 500);
  const POOL_PORT = PORT + 1;
  const TK_PORT = PORT + 2;
  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  let proxyProc, chromeProc;

  function ok(label, cond, extra) {
    cond ? (passed++, console.log(`[PASS] ${label}`)) : (failed++, console.log(`[FAIL] ${label}${extra ? ' → ' + extra : ''}`));
  }

  try {
    console.log('\n=== API Key 鉴权测试（REQUIRE_AUTH=true）===\n');

    // 创建两个 key
    const KEY_A = createKey('auth-test-A');
    const KEY_B = createKey('auth-test-B');
    if (!KEY_A || !KEY_B) throw new Error('创建 key 失败');
    console.log(`Key A: ${KEY_A.slice(0, 16)}...`);
    console.log(`Key B: ${KEY_B.slice(0, 16)}...\n`);

    // 启动 proxy（REQUIRE_AUTH=true）
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin?key=${KEY_A}'`));
    proxyProc = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), POOL_START: String(POOL_PORT), POOL_SIZE: '1',
        TAKEOVER_PORT: String(TK_PORT), POOL_TAKEOVER_PORT: String(TK_PORT),
        LOG_LEVEL: 'warn', REQUIRE_AUTH: 'true' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stdout.on('data', () => {});
    proxyProc.stderr.on('data', () => {});
    if (!await waitForPort(PORT)) throw new Error('Proxy failed to start');
    // 等端口池端口就绪
    for (let i = 0; i < 20; i++) { try { await httpGet(POOL_PORT, '/json/version'); break; } catch { await sleep(500); } }

    // Test 1: /client 不带 key → 被拒
    console.log('[Test 1] /client 不带 key → 应被拒（4001）');
    const r1 = await expectReject(`ws://localhost:${PORT}/client`);
    ok('不带 key 被拒(4001)', r1.rejected, `code=${r1.code}`);

    // Test 2: /client 带错误 key → 被拒
    console.log('\n[Test 2] /client 带错误 key → 应被拒（4001）');
    const r2 = await expectReject(`ws://localhost:${PORT}/client?key=cdp_invalid_key`);
    ok('错误 key 被拒(4001)', r2.rejected, `code=${r2.code}`);

    // Test 3: 扩展带正确 key 连 /plugin
    console.log('\n[Test 3] 扩展带 key A 连 /plugin');
    const profile = `/tmp/cdp-auth-test-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      '--headless=new', `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=DialMediaRouteProvider', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    let extReady = false;
    for (let i = 0; i < 45; i++) {
      try { const b = await httpGet(PORT, '/json/browsers'); if (Array.isArray(b) && b.length > 0) { extReady = true; break; } } catch {}
      await sleep(2000);
    }
    ok('扩展带 key A 连上 proxy', extReady, extReady ? '' : '45s 未连上');

    // Test 4: 客户端带正确 key → createTarget + attach + evaluate
    console.log('\n[Test 4] 客户端带 key A 连 /client');
    const ws = new WebSocket(`ws://localhost:${PORT}/client?key=${KEY_A}`);
    const pending = new Map(); let id = 1;
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    });
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    function cdp(method, params = {}, sid) {
      return new Promise((resolve, reject) => {
        const i = id++; pending.set(i, { resolve, reject });
        setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('Timeout: ' + method)); } }, 15000);
        const o = { id: i, method, params }; if (sid) o.sessionId = sid;
        ws.send(JSON.stringify(o));
      });
    }

    const ct = await cdp('Target.createTarget', { url: 'about:blank' });
    ok('key A createTarget 成功', !!ct.targetId);
    const at = await cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
    ok('key A attach 成功', !!at.sessionId);
    await cdp('Runtime.enable', {}, at.sessionId);
    await sleep(500);
    const ev = await cdp('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }, at.sessionId);
    ok('key A evaluate 成功', !!ev.result.value);
    ws.close();

    // Test 5: key B 无浏览器连接 → /client 应被拒（no browser for this key）
    console.log('\n[Test 5] key B 无浏览器 → /client 应被拒');
    const r5 = await expectReject(`ws://localhost:${PORT}/client?key=${KEY_B}`);
    ok('key B 无浏览器被拒', r5.code !== null && r5.code !== 'timeout', `code=${r5.code}`);

  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`);
    failed++;
  } finally {
    try { proxyProc && proxyProc.kill('SIGTERM'); } catch {}
    try { chromeProc && process.kill(-chromeProc.pid); } catch {}
    try { chromeProc && chromeProc._profile && fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
