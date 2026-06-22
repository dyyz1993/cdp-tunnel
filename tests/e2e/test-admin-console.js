#!/usr/bin/env node
'use strict';

/**
 * 管理控制台测试
 *
 * 验证：
 * 1. GET /admin 返回 HTML 页面
 * 2. GET /admin/api/browsers 返回数组
 * 3. 无 ADMIN_TOKEN 时，localhost 能访问 API
 * 4. 有 ADMIN_TOKEN 时，错误 token 被拒(401)
 * 5. 有 ADMIN_TOKEN 时，正确 token 能访问
 * 6. key CRUD：创建 → 列出 → 吊销
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');

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

function httpReq(port, p, opts = {}) {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    if (opts.body) { headers['Content-Type'] = 'application/json'; }
    const req = http.request(`http://127.0.0.1:${port}${p}`, { method: opts.method || 'GET', headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
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
    console.log('\n=== 管理控制台测试 ===\n');

    // === Part A: 无 ADMIN_TOKEN（localhost 放行）===
    const PORT_A = 29720;
    console.log('[Part A] 无 ADMIN_TOKEN（localhost 放行）');
    const proxyA = startProxy(PORT_A, {});
    proxyA.stdout.on('data', () => {}); proxyA.stderr.on('data', () => {});
    if (await waitForPort(PORT_A)) {
      // Test 1: GET /admin 返回 HTML
      const admin = await httpReq(PORT_A, '/admin');
      ok('GET /admin 返回 HTML', admin.status === 200 && typeof admin.body === 'string' && admin.body.includes('CDP Tunnel'), `status=${admin.status}`);

      // Test 2: GET /admin/api/browsers 返回数组
      const browsers = await httpReq(PORT_A, '/admin/api/browsers');
      ok('GET /admin/api/browsers 返回数组', browsers.status === 200 && Array.isArray(browsers.body), `status=${browsers.status}`);

      // Test 3: key 创建
      const created = await httpReq(PORT_A, '/admin/api/keys', { method: 'POST', body: { name: 'console-test' } });
      ok('POST key 创建成功', created.status === 200 && created.body.key && created.body.pluginUrl, JSON.stringify(created.body).slice(0, 60));

      // Test 4: key 列出
      const listed = await httpReq(PORT_A, '/admin/api/keys');
      ok('GET key 列表包含创建的', listed.status === 200 && Array.isArray(listed.body) && listed.body.some(k => k.name === 'console-test'), `count=${listed.body?.length}`);

      // Test 5: key 吊销
      if (created.body.id) {
        const revoked = await httpReq(PORT_A, '/admin/api/keys/' + created.body.id, { method: 'DELETE' });
        ok('DELETE key 吊销成功', revoked.status === 200 && revoked.body.ok, JSON.stringify(revoked.body));
      }
    } else { ok('Part A proxy 启动', false); }
    proxyA.kill('SIGTERM'); await sleep(500);

    // === Part B: 有 ADMIN_TOKEN ===
    const PORT_B = 29721;
    console.log('\n[Part B] 有 ADMIN_TOKEN=mytoken');
    const proxyB = startProxy(PORT_B, { ADMIN_TOKEN: 'mytoken' });
    proxyB.stdout.on('data', () => {}); proxyB.stderr.on('data', () => {});
    if (await waitForPort(PORT_B)) {
      // Test 6: 无 token 被拒
      const noToken = await httpReq(PORT_B, '/admin/api/browsers');
      ok('无 token 访问 API 被拒(401)', noToken.status === 401, `status=${noToken.status}`);

      // Test 7: 错误 token 被拒
      const badToken = await httpReq(PORT_B, '/admin/api/browsers', { headers: { Authorization: 'Bearer wrong' } });
      ok('错误 token 被拒(401)', badToken.status === 401, `status=${badToken.status}`);

      // Test 8: 正确 token 通过
      const goodToken = await httpReq(PORT_B, '/admin/api/browsers', { headers: { Authorization: 'Bearer mytoken' } });
      ok('正确 token 通过', goodToken.status === 200 && Array.isArray(goodToken.body), `status=${goodToken.status}`);

      // Test 9: query token 也行
      const queryToken = await httpReq(PORT_B, '/admin/api/browsers?token=mytoken');
      ok('query token 通过', queryToken.status === 200, `status=${queryToken.status}`);

      // Test 10: /admin 页面不需要 token（页面本身不含敏感数据）
      const page = await httpReq(PORT_B, '/admin');
      ok('GET /admin 页面不需要 token', page.status === 200, `status=${page.status}`);
    } else { ok('Part B proxy 启动', false); }
    proxyB.kill('SIGTERM'); await sleep(500);

  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`); failed++;
  }
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
