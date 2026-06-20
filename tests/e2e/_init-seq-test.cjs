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
      const t0 = Date.now();
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('T:' + method + ' ' + (Date.now()-t0) + 'ms')); } }, 20000);
      const o = { id: i, method, params: params || {} };
      if (sid) o.sessionId = sid;
      ws.send(JSON.stringify(o));
    });
  }
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

// 模拟 xbrowser 的完整初始化序列
async function xbrowserSession(port, label) {
  const t0 = Date.now();
  try {
    const c = makeClient(port); await c.open;
    console.log(`[${label}] connected`);

    // 1. setAutoAttach
    const sa = c.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    console.log(`[${label}] setAutoAttach sent`);

    // 2. getTargets（discoverContexts）
    const tg = c.cdp('Target.getTargets');
    console.log(`[${label}] getTargets sent`);

    // 3. createTarget
    const ct = c.cdp('Target.createTarget', { url: 'https://www.example.com' });
    console.log(`[${label}] createTarget sent`);

    // 等 setAutoAttach
    await sa;
    console.log(`[${label}] setAutoAttach done`);

    // 等 getTargets
    const targets = await tg;
    const pages = (targets.targetInfos || []).filter(t => t.type === 'page');
    console.log(`[${label}] getTargets done: ${pages.length} pages`);

    // 等 createTarget
    const ctResult = await ct;
    if (!ctResult || !ctResult.targetId) {
      console.log(`[${label}] ❌ createTarget returned no targetId`);
      return { ok: false };
    }
    console.log(`[${label}] createTarget done: ${ctResult.targetId.slice(0, 8)}`);

    // attach
    const at = await c.cdp('Target.attachToTarget', { targetId: ctResult.targetId, flatten: true });
    await c.cdp('Page.enable', {}, at.sessionId);
    await c.cdp('Page.navigate', { url: 'https://www.example.com' }, at.sessionId);
    await new Promise(r => setTimeout(r, 2000));

    const urlResult = await c.cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, at.sessionId);
    const url = urlResult.result.value;
    console.log(`[${label}] final url: ${url} (${Date.now()-t0}ms)`);

    await c.cdp('Target.closeTarget', { targetId: ctResult.targetId }).catch(() => {});
    c.ws.close();
    return { ok: url.includes('example.com') };
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message} (${Date.now()-t0}ms)`);
    return { ok: false };
  }
}

(async () => {
  console.log('=== 单连接初始化测试（5次）===\n');
  for (let i = 1; i <= 5; i++) {
    const r = await xbrowserSession(9231, 's' + i);
    console.log(`s${i}: ${r.ok ? '✅' : '❌'}\n`);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.exit(0);
})();
