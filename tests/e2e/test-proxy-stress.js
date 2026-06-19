#!/usr/bin/env node
'use strict';

/**
 * 压测 Proxy 端：连续操作，监控 proxy-server Node.js 进程的：
 * 1. RSS（常驻内存）
 * 2. Heap Used（JS 堆）
 * 3. Heap Total（JS 堆总量）
 * 4. 响应时间趋势
 *
 * 自己起 proxy + Chromium + 扩展，全程独立端口。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PORT = parseInt(process.env.PORT || '0', 10) || (10000 + Math.floor(Math.random() * 50000));
const ITERATIONS = parseInt(process.env.ITERATIONS || '100', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, res => {
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

// 读 proxy 进程内存：通过 pidusage 或直接 /proc。macOS 用 ps。
function getProxyMem(pid) {
  try {
    const out = require('child_process').execSync(
      `ps -o rss= -p ${pid}`, { encoding: 'utf8' }
    ).trim();
    return { rssKB: parseInt(out, 10) };
  } catch { return { rssKB: null }; }
}

// 读 proxy 内部 Node.js 堆：通过 --inspect 或 HTTP 端点
// proxy-server 没有 metrics 端点，用 ps 的 RSS 作为主要指标
// 同时用 process.memoryStructure 需要 proxy 端配合，这里先用 RSS

let proxyProc, chromeProc, ws, configOriginal;

(async () => {
  console.log(`\n=== Proxy 压测: ${ITERATIONS} 次操作 ===\n`);

  try {
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PORT}/plugin'`
    ));

    // 起 proxy（带 --expose-gc 方便观察，但主要靠 ps）
    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
    for (let i = 0; i < 20; i++) {
      try { await httpGet(PORT, '/json/version'); break; } catch { await sleep(500); }
    }

    const proxyPid = proxyProc.pid;
    console.log(`Proxy PID: ${proxyPid}`);

    // 起 Chromium
    const profile = `/tmp/cdp-proxy-stress-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    await sleep(4000);

    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try {
        const ver = await httpGet(PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension connected\n');

    // 连 client
    ws = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    setupRouter(ws);
    await sleep(500);

    await cdp(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(2000);
    const tg = await cdp(ws, 'Target.getTargets');
    const target = (tg.targetInfos || []).filter(t => t.type === 'page').pop();
    const sid = (await cdp(ws, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await cdp(ws, 'Page.enable', {}, sid);
    await cdp(ws, 'Runtime.enable', {}, sid);
    await cdp(ws, 'Runtime.evaluate', {
      expression: `document.body.innerHTML='<input id=x><button id=b>btn</button>';window.__k=0;window.__c=0;document.getElementById('x').addEventListener('keydown',function(){window.__k++});document.getElementById('b').addEventListener('click',function(){window.__c++});document.getElementById('x').focus()`
    }, sid);
    await sleep(500);

    const times = { key: [], click: [], eval: [] };
    const memSamples = [];

    console.log('Iter | Key(ms) | Eval(ms) | Proxy RSS(MB) | Key✓');
    console.log('-----|---------|----------|---------------|-----');

    for (let i = 0; i < ITERATIONS; i++) {
      // keyboard（触发 ensureVisible，走 proxy → 扩展 → Chrome）
      const kr = await cdp(ws, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
      }, sid).catch(e => ({ _ms: -1 }));
      await cdp(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
      }, sid).catch(() => {});
      times.key.push(kr._ms);

      // Runtime.evaluate（不走 ensureVisible，对照）
      const er = await cdp(ws, 'Runtime.evaluate', {
        expression: '1+1', returnByValue: true
      }, sid);
      times.eval.push(er._ms);

      // 每 10 次采样
      if ((i + 1) % 10 === 0 || i === 0) {
        const mem = getProxyMem(proxyPid);
        const kCount = (await cdp(ws, 'Runtime.evaluate', { expression: 'window.__k', returnByValue: true }, sid)).result.value;
        const rssMB = mem.rssKB ? Math.round(mem.rssKB / 1024) : '?';
        memSamples.push({ iter: i + 1, rss: rssMB });
        console.log(
          `${String(i + 1).padStart(5)}|` +
          `${String(kr._ms).padStart(9)}|` +
          `${String(er._ms).padStart(10)}|` +
          `${String(rssMB).padStart(15)}|` +
          `${kCount > 0 ? ' ✅' : ' ❌'}`
        );
      }

      await sleep(30);
    }

    ws.close();

    // 分析
    console.log('\n=== Proxy 压测分析 ===\n');

    const q = Math.floor(ITERATIONS / 4);
    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const earlyKey = times.key.slice(0, q).filter(t => t > 0);
    const lateKey = times.key.slice(-q).filter(t => t > 0);
    const earlyEval = times.eval.slice(0, q).filter(t => t > 0);
    const lateEval = times.eval.slice(-q).filter(t => t > 0);

    console.log(`响应时间（前 ${q} vs 后 ${q}）:`);
    console.log(`  keyboard(经 ensureVisible): ${avg(earlyKey)}ms → ${avg(lateKey)}ms ${avg(lateKey) > avg(earlyKey) * 2 ? '⚠️' : '✅'}`);
    console.log(`  evaluate(直通):            ${avg(earlyEval)}ms → ${avg(lateEval)}ms ${avg(lateEval) > avg(earlyEval) * 2 ? '⚠️' : '✅'}`);

    if (memSamples.length >= 2) {
      const first = memSamples[0].rss;
      const last = memSamples[memSamples.length - 1].rss;
      const delta = last - first;
      console.log(`\nProxy RSS: ${first}MB → ${last}MB (${delta > 0 ? '+' : ''}${delta}MB)`);
      // Node.js GC 会有波动，允许 30MB 以内的波动
      if (delta > 50) console.log('⚠️ RSS 明显增长（可能泄漏，建议多跑几轮确认）');
      else if (delta > 20) console.log('⚠️ RSS 轻微增长（可能是 GC 波动，建议关注）');
      else console.log('✅ RSS 稳定');
    }

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
  } finally {
    if (ws) try { ws.close(); } catch {}
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  process.exit(0);
})();
