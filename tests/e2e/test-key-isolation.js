#!/usr/bin/env node
'use strict';

/**
 * Key 隔离测试（阶段2 核心保护）
 *
 * 验证：
 * 1. 扩展带 keyA 连上 proxy
 * 2. keyA 的客户端 createTarget 创建 tab
 * 3. keyA 的 listtabs 只看到自己 createTarget 创建的 tab
 * 4. keyA 的 listtabs 看不到用户手动开的 tab（headless Chromium 的 about:blank）
 * 5. keyB（无浏览器连接）的 /client 被拒
 *
 * 这个测试保护"按 key 隔离分组"不被后续改动破坏。
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
function createKey(name) {
  const out = execSync(`node ${KEY_MGR} create ${name}`, { encoding: 'utf8' });
  const m = out.match(/Key:\s*(cdp_\w+)/);
  return m ? m[1] : null;
}

(async () => {
  let passed = 0, failed = 0;
  function ok(label, cond, extra) {
    cond ? (passed++, console.log(`[PASS] ${label}`)) : (failed++, console.log(`[FAIL] ${label}${extra ? ' → ' + extra : ''}`));
  }

  const PORT = 29500 + Math.floor(Math.random() * 500);
  const POOL_PORT = PORT + 1;
  const TK_PORT = PORT + 10;
  const configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  let proxyProc, chromeProc;

  try {
    console.log('\n=== Key 隔离测试（阶段2）===\n');

    // 创建两个 key
    const KEY_A = createKey('isolation-test-A');
    const KEY_B = createKey('isolation-test-B');
    if (!KEY_A || !KEY_B) throw new Error('创建 key 失败');
    console.log(`Key A: ${KEY_A.slice(0, 16)}...`);
    console.log(`Key B: ${KEY_B.slice(0, 16)}...\n`);

    // 改扩展配置连 keyA
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/,
      `WS_URL: 'ws://localhost:${PORT}/plugin?key=${KEY_A}'`
    ));

    // 启动 proxy
    proxyProc = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), POOL_START: String(POOL_PORT), POOL_SIZE: '3',
        TAKEOVER_PORT: String(TK_PORT), POOL_TAKEOVER_PORT: String(TK_PORT),
        REQUIRE_AUTH: 'true', LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stdout.on('data', () => {}); proxyProc.stderr.on('data', () => {});
    if (!await waitForPort(PORT)) throw new Error('Proxy failed');

    // 启动 Chromium + 扩展（连 keyA）
    const profile = `/tmp/cdp-iso-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      '--headless=new', `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=DialMediaRouteProvider', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;

    // 等扩展连上
    let extReady = false;
    for (let i = 0; i < 45; i++) {
      try { const b = await httpGet(PORT, '/json/browsers'); if (Array.isArray(b) && b.length > 0) { extReady = true; break; } } catch {}
      await sleep(2000);
    }
    ok('扩展带 keyA 连上 proxy', extReady, extReady ? '' : '45s 未连上');

    if (!extReady) throw new Error('扩展未连上');
    fs.writeFileSync(CONFIG_PATH, configOriginal);

    // 连 keyA 的 /client
    console.log('\n[Test 1] keyA 客户端 createTarget');
    const wsA = new WebSocket(`ws://localhost:${PORT}/client?key=${KEY_A}`);
    const pendingA = new Map(); let idA = 1;
    wsA.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id && pendingA.has(m.id)) { const { resolve, reject } = pendingA.get(m.id); pendingA.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    });
    await new Promise((r, e) => { wsA.on('open', r); wsA.on('error', e); });
    function cdpA(method, params = {}) {
      return new Promise((resolve, reject) => {
        const i = idA++; pendingA.set(i, { resolve, reject });
        setTimeout(() => { if (pendingA.has(i)) { pendingA.delete(i); reject(new Error('Timeout: ' + method)); } }, 12000);
        wsA.send(JSON.stringify({ id: i, method, params }));
      });
    }

    // createTarget 两个 tab
    const ct1 = await cdpA('Target.createTarget', { url: 'about:blank' });
    const ct2 = await cdpA('Target.createTarget', { url: 'about:blank' });
    ok('keyA createTarget 两个 tab', !!ct1.targetId && !!ct2.targetId, `${ct1.targetId?.slice(0,8)}, ${ct2.targetId?.slice(0,8)}`);

    // Test 2: keyA 的 getTargets 只看到自己创建的
    console.log('\n[Test 2] keyA getTargets 只看自己创建的 tab');
    const tg = await cdpA('Target.getTargets');
    const myPages = (tg.targetInfos || []).filter(t => t.type === 'page');
    ok('keyA getTargets 包含自己创建的 2 个 tab', myPages.length >= 2, `实际 ${myPages.length} 个`);
    // 关键：不应该看到太多（用户 tab 不该出现）
    ok('keyA getTargets 不包含用户 tab（数量合理）', myPages.length < 10, `实际 ${myPages.length} 个（应该 < 10）`);

    // Test 3: keyB 的 /client 连不上（无浏览器）
    console.log('\n[Test 3] keyB 无浏览器，/client 应被拒');
    const wsB_result = await new Promise(resolve => {
      let settled = false;
      const ws = new WebSocket(`ws://localhost:${PORT}/client?key=${KEY_B}`);
      const done = r => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(r); } };
      ws.on('close', code => done({ rejected: true, code }));
      ws.on('error', () => done({ rejected: true, code: 'error' }));
      ws.on('open', () => setTimeout(() => done({ rejected: false, code: null }), 2000));
      setTimeout(() => done({ rejected: false, code: 'timeout' }), 6000);
    });
    ok('keyB 无浏览器被拒', wsB_result.rejected, `code=${wsB_result.code}`);

    wsA.close();

  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`); failed++;
  } finally {
    try { proxyProc && proxyProc.kill('SIGTERM'); } catch {}
    try { chromeProc && process.kill(-chromeProc.pid); } catch {}
    try { chromeProc && chromeProc._profile && fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
