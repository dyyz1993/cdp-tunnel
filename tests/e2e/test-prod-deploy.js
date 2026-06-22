#!/usr/bin/env node
'use strict';

/**
 * 生产环境部署验证测试（连真实云地址）
 *
 * 这个测试连真实的云 proxy，验证部署是否正常。
 * 不进 pre-commit（依赖外部服务），手动跑或 CI 部署后跑。
 *
 * 用法：
 *   PROD_WSS=wss://cdp.shanbox.19930810.xyz:8443 \
 *   PROD_KEY=cdp_xxx \
 *   node tests/e2e/test-prod-deploy.js
 *
 * 环境变量：
 *   PROD_WSS  云 proxy 的 wss 地址（不含路径和 key）
 *   PROD_KEY  API key
 *
 * 如果没设这两个变量，测试跳过（exit 0）。
 */

const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const PROD_WSS = process.env.PROD_WSS;
const PROD_KEY = process.env.PROD_KEY;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    }).on('error', reject);
  });
}

function expectReject(url) {
  return new Promise(resolve => {
    let settled = false;
    const ws = new WebSocket(url);
    const done = r => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(r); } };
    ws.on('close', code => done({ rejected: code === 4001 || code === 4002, code }));
    ws.on('error', () => done({ rejected: false, code: 'error' }));
    ws.on('open', () => setTimeout(() => done({ rejected: false, code: null }), 3000));
    setTimeout(() => done({ rejected: false, code: 'timeout' }), 8000);
  });
}

(async () => {
  let passed = 0, failed = 0;
  function ok(label, cond, extra) {
    cond ? (passed++, console.log(`[PASS] ${label}`)) : (failed++, console.log(`[FAIL] ${label}${extra ? ' → ' + extra : ''}`));
  }

  // 没配环境变量 → 跳过
  if (!PROD_WSS || !PROD_KEY) {
    console.log('\n⚠️  跳过生产环境测试（未设 PROD_WSS / PROD_KEY 环境变量）');
    console.log('    用法: PROD_WSS=wss://域名:端口 PROD_KEY=cdp_xxx node test-prod-deploy.js');
    process.exit(0);
  }

  console.log(`\n=== 生产环境部署验证 ===`);
  console.log(`目标: ${PROD_WSS}\n`);

  try {
    // 1. HTTPS /json/version 可达
    console.log('[Test 1] HTTPS /json/version 可达');
    const httpsBase = PROD_WSS.replace('wss://', 'https://').replace('ws://', 'http://');
    const ver = await httpGet(`${httpsBase}/json/version`);
    ok('HTTPS /json/version 返回 200', ver.status === 200, `status=${ver.status}`);
    ok('返回 webSocketDebuggerUrl', ver.body && ver.body.webSocketDebuggerUrl, JSON.stringify(ver.body).slice(0, 80));
    console.log(`     Browser: ${ver.body?.Browser || 'N/A'}`);
    console.log('');

    // 2. 不带 key 被拒
    console.log('[Test 2] /client 不带 key → 被拒');
    const r2 = await expectReject(`${PROD_WSS}/client`);
    ok('不带 key 被拒', r2.rejected, `code=${r2.code}`);
    console.log('');

    // 3. 错误 key 被拒
    console.log('[Test 3] /client 错误 key → 被拒');
    const r3 = await expectReject(`${PROD_WSS}/client?key=cdp_invalid`);
    ok('错误 key 被拒', r3.rejected, `code=${r3.code}`);
    console.log('');

    // 4. 正确 key 连上 + CDP 全链路
    console.log('[Test 4] 正确 key → CDP 全链路');
    const ws = new WebSocket(`${PROD_WSS}/client?key=${PROD_KEY}`);
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
    ok('正确 key 连上 /client', true);

    // 检查有没有扩展连着（/json/browsers）
    const browsers = await httpGet(`${httpsBase}/json/browsers`);
    const hasBrowser = Array.isArray(browsers.body) && browsers.body.length > 0;
    ok('云上有浏览器（扩展已连）', hasBrowser, `count=${Array.isArray(browsers.body) ? browsers.body.length : 0}`);
    if (hasBrowser) {
      console.log(`     浏览器: ${browsers.body[0].pluginId}`);
    }
    console.log('');

    // createTarget + attach + evaluate
    console.log('[Test 5] CDP 操作（createTarget + evaluate）');
    const ct = await cdp('Target.createTarget', { url: 'about:blank' });
    ok('远程 createTarget', !!ct.targetId, ct.targetId?.slice(0, 12));

    const at = await cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
    ok('远程 attachToTarget', !!at.sessionId, at.sessionId?.slice(0, 12));

    await cdp('Runtime.enable', {}, at.sessionId);
    const ua = await cdp('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }, at.sessionId);
    ok('远程 evaluate 拿到 UA', !!ua.result.value, (ua.result.value || '').slice(0, 60));
    console.log(`     浏览器 UA: ${(ua.result.value || '').slice(0, 80)}`);

    await cdp('Target.closeTarget', { targetId: ct.targetId });
    ok('远程 closeTarget 清理', true);
    ws.close();
    console.log('');

  } catch (e) {
    console.log(`\n[ERROR] ${e.message}`);
    failed++;
  }

  console.log(`=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
