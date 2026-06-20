/**
 * 精确模拟 xbrowser 的两阶段 CDP 序列
 * 阶段 1：连接初始化（getTargets + attach已有page + enable domains + setAutoAttach）
 * 阶段 2：创建新 page（createTarget + attach + enable + navigate）
 *
 * 并发多个 session，验证"第一个必挂"
 */
const WebSocket = require('/Users/xuyingzhou/Project/study-web/cdp-tunnel2/node_modules/ws');

function makeClient(port) {
  const ws = new WebSocket('ws://localhost:' + port + '/client');
  const pending = new Map();
  let id = 1;
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });
  function cdp(method, params, sid) {
    return new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('T:' + method)); } }, 20000);
      const o = { id: i, method, params: params || {} };
      if (sid) o.sessionId = sid;
      ws.send(JSON.stringify(o));
    });
  }
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

// 精确模拟 xbrowser 的两阶段
async function xbrowserFullSession(port, label) {
  try {
    const c = makeClient(port); await c.open;

    // === 阶段 1：连接初始化 ===
    // 1. getTargets（发现已有 page）
    const tg = await c.cdp('Target.getTargets');
    const existingPages = (tg.targetInfos || []).filter(t => t.type === 'page');

    // 2. attach 已有 page（如果有）
    const attachedSessions = [];
    for (const page of existingPages) {
      try {
        const at = await c.cdp('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        if (at && at.sessionId) {
          attachedSessions.push(at.sessionId);
          // 3. enable domains
          await c.cdp('Page.enable', {}, at.sessionId).catch(() => {});
          await c.cdp('Runtime.enable', {}, at.sessionId).catch(() => {});
          await c.cdp('Network.enable', {}, at.sessionId).catch(() => {});
          await c.cdp('Browser.enable', {}, at.sessionId).catch(() => {});
        }
      } catch (e) {
        // attach 可能失败（被其他 client 占了），忽略
      }
    }

    // 4. setAutoAttach
    await c.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    // === 阶段 2：创建新 page ===
    // 5. createTarget
    const ct = await c.cdp('Target.createTarget', { url: 'about:blank' });
    if (!ct || !ct.targetId) return { label, ok: false, reason: 'createTarget no targetId' };
    const tid = ct.targetId;

    // 6. attach 新 target
    const at = await c.cdp('Target.attachToTarget', { targetId: tid, flatten: true });
    if (!at || !at.sessionId) return { label, ok: false, reason: 'attach failed' };
    const sid = at.sessionId;

    // 7. enable domains
    await c.cdp('Page.enable', {}, sid);
    await c.cdp('Runtime.enable', {}, sid);
    await c.cdp('Network.enable', {}, sid);

    // 8. navigate
    const nav = await c.cdp('Page.navigate', { url: 'https://www.example.com' }, sid);
    await new Promise(r => setTimeout(r, 3000));

    // 9. 验证 url
    const urlResult = await c.cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sid);
    const url = urlResult.result.value;

    // 清理
    await c.cdp('Target.closeTarget', { targetId: tid }).catch(() => {});
    c.ws.close();

    return { label, ok: url.includes('example.com'), reason: url };
  } catch (e) {
    return { label, ok: false, reason: e.message.slice(0, 80) };
  }
}

(async () => {
  const CONCURRENCY = parseInt(process.env.C || '5');
  const BATCHES = parseInt(process.env.B || '4');
  let ok = 0, fail = 0;
  const failures = [];

  console.log(`=== 两阶段并发: ${CONCURRENCY}×${BATCHES} ===\n`);

  for (let batch = 1; batch <= BATCHES; batch++) {
    // 并发启动所有 session
    const sessions = [];
    for (let i = 1; i <= CONCURRENCY; i++) {
      sessions.push(xbrowserFullSession(9231, `b${batch}_s${i}`));
    }
    const results = await Promise.all(sessions);
    for (const r of results) {
      if (r.ok) { ok++; }
      else { fail++; failures.push(r.label + ': ' + r.reason.slice(0, 40)); }
      console.log((r.ok ? '✅' : '❌') + ' ' + r.label + ': ' + r.reason.slice(0, 50));
    }
    console.log('');
    await new Promise(r => setTimeout(r, 1000));
  }

  const total = ok + fail;
  console.log(`=== 结果: ${ok}/${total} (${Math.round(fail/total*100)}% 失败) ===`);
  if (failures.length > 0) {
    console.log('失败:');
    failures.forEach(f => console.log('  ' + f));
  }
  process.exit(0);
})();
