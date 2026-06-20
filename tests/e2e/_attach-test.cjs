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
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('T:' + method)); } }, 15000);
      const o = { id: i, method, params: params || {} };
      if (sid) o.sessionId = sid;
      ws.send(JSON.stringify(o));
    });
  }
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

(async () => {
  const c1 = makeClient(9231); await c1.open;
  const ct = await c1.cdp('Target.createTarget', { url: 'https://www.example.com' });
  const tid = ct.targetId;
  console.log('targetId:', tid.slice(0, 12));

  const at1 = await c1.cdp('Target.attachToTarget', { targetId: tid, flatten: true });
  const sid1 = at1.sessionId;
  console.log('client1 session:', sid1.slice(0, 12));

  await c1.cdp('Runtime.enable', {}, sid1);
  const ev1 = await c1.cdp('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sid1);
  console.log('client1 eval (before):', ev1.result.value);

  const c2 = makeClient(9231); await c2.open;
  const at2 = await c2.cdp('Target.attachToTarget', { targetId: tid, flatten: true });
  const sid2 = at2 ? at2.sessionId : null;
  console.log('client2 session:', sid2 ? sid2.slice(0, 12) : 'null');

  if (sid2) {
    await c2.cdp('Runtime.enable', {}, sid2);
    const ev2 = await c2.cdp('Runtime.evaluate', { expression: '2+2', returnByValue: true }, sid2);
    console.log('client2 eval:', ev2.result.value);
  }

  const ev1b = await c1.cdp('Runtime.evaluate', { expression: '3+3', returnByValue: true }, sid1).catch(e => ({ error: e.message }));
  if (ev1b.error) {
    console.log('client1 eval (after): ERROR -', ev1b.error);
    console.log('❌ 排他冲突');
  } else if (ev1b.result && ev1b.result.value === 6) {
    console.log('client1 eval (after):', ev1b.result.value);
    console.log('✅ 无冲突（对齐直连 Chrome）');
  } else {
    console.log('client1 eval (after):', JSON.stringify(ev1b).slice(0, 80));
    console.log('⚠️ 异常');
  }

  c1.ws.close(); c2.ws.close();
  process.exit(0);
})();
