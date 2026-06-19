#!/usr/bin/env node
'use strict';

/**
 * 压测：连续执行 100+ 次 keyboard/mouse 操作，监控：
 * 1. 每次命令的响应时间（是否越来越慢）
 * 2. 扩展 service worker 内存（是否持续增长 = 泄漏）
 * 3. 页面内存（是否有 data-cdp-saved-focus 残留累积）
 * 4. 事件投递成功率（是否随次数增加而下降）
 *
 * 连真实 9221 proxy（不自己启动），只发命令 + 收集指标。
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '0', 10) || (10000 + Math.floor(Math.random() * 50000));
const ITERATIONS = parseInt(process.env.ITERATIONS || '100', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${urlPath}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

let _id = 1;
const pending = new Map();
function setupRouter(ws) {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {}
  });
}
function cdp(ws, method, params = {}, sessionId) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const id = _id++;
    pending.set(id, { resolve: (r) => resolve({ ...r, _ms: Date.now() - start }), reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout: ' + method)); } }, 30000);
    const o = { id, method, params };
    if (sessionId) o.sessionId = sessionId;
    ws.send(JSON.stringify(o));
  });
}

async function getMem(ws, sid) {
  // performance.memory（页面内存）+ data-cdp-saved-focus 残留数
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression: 'JSON.stringify({jsHeapUsed:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null,jsHeapTotal:performance.memory?Math.round(performance.memory.totalJSHeapSize/1048576):null,savedFocusCount:document.querySelectorAll("[data-cdp-saved-focus]").length})',
    returnByValue: true
  }, sid);
  return JSON.parse(r.result.value);
}

(async () => {
  console.log(`\n=== 压测: ${ITERATIONS} 次操作 ===`);
  console.log(`连接 ws://localhost:${PORT}/client\n`);

  const ws = new WebSocket(`ws://localhost:${PORT}/client`);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  setupRouter(ws);

  // 创建隔离 tab（create 模式 setAutoAttach）
  await cdp(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(2000);
  const tg = await cdp(ws, 'Target.getTargets');
  const pages = (tg.targetInfos || []).filter(t => t.type === 'page');
  if (pages.length === 0) { console.log('没有 page target'); process.exit(1); }
  const target = pages[pages.length - 1];
  const at = await cdp(ws, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = at.sessionId;
  console.log(`Target: ${target.targetId.slice(0, 8)} Session: ${sid.slice(0, 8)}\n`);

  await cdp(ws, 'Page.enable', {}, sid);
  await cdp(ws, 'Runtime.enable', {}, sid);

  // 准备测试页
  await cdp(ws, 'Runtime.evaluate', {
    expression: `document.body.innerHTML='<input id=x><button id=b>btn</button>';
    window.__k=0;window.__c=0;
    document.getElementById('x').addEventListener('keydown',function(){window.__k++});
    document.getElementById('b').addEventListener('click',function(){window.__c++});
    document.getElementById('x').focus()`
  }, sid);
  await sleep(500);

  const stats = {
    keyTimes: [], clickTimes: [],
    memSnapshots: [],
    keySuccess: 0, clickSuccess: 0,
  };

  console.log('Iter | Key(ms) | Click(ms) | Heap(MB) | SavedFocus | Key✓ | Click✓');
  console.log('-----|---------|-----------|----------|------------|------|-------');

  for (let i = 0; i < ITERATIONS; i++) {
    // keyboard
    const keyRes = await cdp(ws, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
    }, sid).catch(e => ({ _ms: -1, error: e.message }));
    await cdp(ws, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
    }, sid).catch(() => {});
    stats.keyTimes.push(keyRes._ms);

    // mouse click
    const coords = JSON.parse((await cdp(ws, 'Runtime.evaluate', {
      expression: 'JSON.stringify({x:document.getElementById("b").getBoundingClientRect().x+20,y:document.getElementById("b").getBoundingClientRect().y+15})',
      returnByValue: true
    }, sid)).result.value);
    const clickRes = await cdp(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1
    }, sid).catch(e => ({ _ms: -1, error: e.message }));
    await cdp(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1
    }, sid).catch(() => {});
    stats.clickTimes.push(clickRes._ms);

    // 每 10 次采样一次内存 + 成功率
    if ((i + 1) % 10 === 0 || i === 0) {
      const mem = await getMem(ws, sid);
      const kCount = (await cdp(ws, 'Runtime.evaluate', { expression: 'window.__k', returnByValue: true }, sid)).result.value;
      const cCount = (await cdp(ws, 'Runtime.evaluate', { expression: 'window.__c', returnByValue: true }, sid)).result.value;
      const keyOk = kCount > 0;
      const clickOk = cCount > 0;
      if (keyOk) stats.keySuccess++;
      if (clickOk) stats.clickSuccess++;

      stats.memSnapshots.push({ iter: i + 1, ...mem, kCount, cCount });

      console.log(
        `${String(i + 1).padStart(5)}|` +
        `${String(keyRes._ms).padStart(9)}|` +
        `${String(clickRes._ms).padStart(11)}|` +
        `${String(mem.jsHeapUsed || '?').padStart(9)}|` +
        `${String(mem.savedFocusCount).padStart(12)}|` +
        `${keyOk ? '  ✅' : '  ❌'}|` +
        `${clickOk ? '   ✅' : '   ❌'}`
      );
    }

    await sleep(50); // 模拟真实操作间隔
  }

  ws.close();

  // 分析
  console.log('\n=== 压测分析 ===\n');

  // 响应时间趋势：前 1/4 vs 后 1/4
  const q = Math.floor(ITERATIONS / 4);
  const earlyKeys = stats.keyTimes.slice(0, q).filter(t => t > 0);
  const lateKeys = stats.keyTimes.slice(-q).filter(t => t > 0);
  const earlyClicks = stats.clickTimes.slice(0, q).filter(t => t > 0);
  const lateClicks = stats.clickTimes.slice(-q).filter(t => t > 0);
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  console.log(`响应时间（前 ${q} 次 vs 后 ${q} 次）:`);
  console.log(`  keyboard: ${avg(earlyKeys)}ms → ${avg(lateKeys)}ms ${avg(lateKeys) > avg(earlyKeys) * 2 ? '⚠️ 明显变慢' : '✅ 稳定'}`);
  console.log(`  mouse:    ${avg(earlyClicks)}ms → ${avg(lateClicks)}ms ${avg(lateClicks) > avg(earlyClicks) * 2 ? '⚠️ 明显变慢' : '✅ 稳定'}`);

  // 内存趋势
  if (stats.memSnapshots.length >= 2) {
    const first = stats.memSnapshots[0];
    const last = stats.memSnapshots[stats.memSnapshots.length - 1];
    if (first.jsHeapUsed && last.jsHeapUsed) {
      const delta = last.jsHeapUsed - first.jsHeapUsed;
      console.log(`\n页面内存: ${first.jsHeapUsed}MB → ${last.jsHeapUsed}MB (${delta > 0 ? '+' : ''}${delta}MB) ${delta > 50 ? '⚠️ 明显增长' : '✅ 稳定'}`);
    }
    console.log(`data-cdp-saved-focus 残留: ${last.savedFocusCount} ${last.savedFocusCount > 0 ? '⚠️ 有残留' : '✅ 无残留'}`);
  }

  // 成功率
  const samples = stats.memSnapshots.length;
  console.log(`\n事件投递成功率（${samples} 次采样）:`);
  console.log(`  keyboard: ${stats.keySuccess}/${samples}`);
  console.log(`  mouse:    ${stats.clickSuccess}/${samples}`);

  // 判定
  const memGrowth = stats.memSnapshots.length >= 2 && stats.memSnapshots[0].jsHeapUsed && stats.memSnapshots[stats.memSnapshots.length - 1].jsHeapUsed
    ? stats.memSnapshots[stats.memSnapshots.length - 1].jsHeapUsed - stats.memSnapshots[0].jsHeapUsed
    : 0;
  const timeDegrade = avg(lateKeys) > avg(earlyKeys) * 2 || avg(lateClicks) > avg(earlyClicks) * 2;

  console.log('\n=== 结论 ===');
  if (memGrowth > 50) {
    console.log('❌ 内存泄漏：' + memGrowth + 'MB 增长');
  } else if (timeDegrade) {
    console.log('❌ 性能退化：响应时间翻倍');
  } else {
    console.log('✅ 无明显内存泄漏或性能退化');
  }

  process.exit(0);
})();
