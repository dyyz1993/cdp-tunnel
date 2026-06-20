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

async function oneSession(port, label) {
  try {
    const c = makeClient(port); await c.open;
    const ct = await c.cdp('Target.createTarget', { url: 'https://www.example.com' });
    if (!ct || !ct.targetId) return { label, ok: false, reason: 'createTarget failed' };
    const tid = ct.targetId;

    const at = await c.cdp('Target.attachToTarget', { targetId: tid, flatten: true });
    if (!at || !at.sessionId) return { label, ok: false, reason: 'attach failed' };
    const sid = at.sessionId;

    await c.cdp('Page.enable', {}, sid);
    await c.cdp('Runtime.enable', {}, sid);
    await c.cdp('Page.navigate', { url: 'https://www.example.com' }, sid);
    await new Promise(r => setTimeout(r, 3000));

    const urlResult = await c.cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sid);
    const finalUrl = urlResult.result.value;

    await c.cdp('Target.closeTarget', { targetId: tid }).catch(() => {});
    c.ws.close();

    return { label, ok: finalUrl.includes('example.com'), reason: finalUrl };
  } catch (e) {
    return { label, ok: false, reason: e.message };
  }
}

(async () => {
  const CONCURRENCY = 5;
  const BATCHES = 4;
  let ok = 0, fail = 0;
  const failures = [];

  console.log('=== 并发测试: ' + CONCURRENCY + '并发 × ' + BATCHES + '批 ===\n');

  for (let batch = 1; batch <= BATCHES; batch++) {
    const sessions = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      sessions.push(oneSession(9231, 'b' + batch + '-s' + i));
    }
    const results = await Promise.all(sessions);
    for (const r of results) {
      if (r.ok) { ok++; }
      else { fail++; failures.push(r.label + ': ' + r.reason); }
      console.log((r.ok ? '✅' : '❌') + ' ' + r.label + ': ' + r.reason.slice(0, 50));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n=== 结果: ' + ok + ' ok, ' + fail + ' fail (' + Math.round(fail / (ok + fail) * 100) + '% 失败) ===');
  if (failures.length > 0) {
    console.log('失败明细:');
    failures.forEach(f => console.log('  ' + f));
  }
  process.exit(0);
})();
