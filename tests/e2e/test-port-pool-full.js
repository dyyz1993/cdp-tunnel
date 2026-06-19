#!/usr/bin/env node
'use strict';

/**
 * v3.0 端口池完整 CDP 链路验证
 *
 * 验证场景：
 * 1. createTarget → attachToTarget → Page.enable → Runtime.evaluate 完整链路
 * 2. 同一端口多客户端共享 tab（对齐原生 Chrome）
 * 3. 断开后 tab 仍存活（新 client 能看到旧 tab）
 * 4. Page.navigate 在端口池模式下工作
 * 5. screencast（Page.captureScreenshot）工作
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

const PLUGIN_PORT = 20000 + Math.floor(Math.random() * 5000);
const CREATE_A = PLUGIN_PORT + 1;
const CREATE_B = PLUGIN_PORT + 2;
const TAKEOVER_PORT = PLUGIN_PORT + 10;

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

function makeClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const pending = new Map();
  let clientId = 1;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = clientId++;
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Timeout: ' + method)); } }, 20000);
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      ws.send(JSON.stringify(o));
    });
  }
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

let proxyProc, chromeProc, configOriginal;
let passed = 0, failed = 0;
function record(label, pass, detail) {
  if (pass) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log(`\n[Port Pool Full CDP] plugin=${PLUGIN_PORT} A=${CREATE_A} B=${CREATE_B}`);

  try {
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: {
        ...process.env,
        PORT: String(PLUGIN_PORT),
        TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(CREATE_A),
        POOL_SIZE: '2',
        POOL_TAKEOVER_PORT: String(TAKEOVER_PORT),
        LOG_LEVEL: 'warn'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });

    for (let i = 0; i < 20; i++) {
      try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); }
    }

    const profile = `/tmp/cdp-pool-full-${Date.now()}`;
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
        const ver = await httpGet(PLUGIN_PORT, '/json/version');
        if (ver && ver.webSocketDebuggerUrl) { extReady = true; break; }
      } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension connected\n');

    // === 场景 1: 完整 CDP 链路 ===
    console.log('▼ 场景 1: createTarget → attach → evaluate 完整链路');
    const client1 = makeClient(CREATE_A);
    await client1.open;

    const ct = await client1.cdp('Target.createTarget', { url: 'about:blank' }).catch(e => ({ error: e.message }));
    record('createTarget', !!ct?.targetId, ct?.error);

    if (ct?.targetId) {
      const at = await client1.cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true }).catch(e => ({ error: e.message }));
      record('attachToTarget', !!at?.sessionId, at?.error);

      if (at?.sessionId) {
        const sid = at.sessionId;
        await client1.cdp('Page.enable', {}, sid).catch(() => {});
        await client1.cdp('Runtime.enable', {}, sid).catch(() => {});

        const evalRes = await client1.cdp('Runtime.evaluate', {
          expression: '1 + 1', returnByValue: true
        }, sid).catch(e => ({ error: e.message }));
        record('Runtime.evaluate (1+1)', evalRes?.result?.value === 2, `value=${evalRes?.result?.value}`);

        // navigate
        const navRes = await client1.cdp('Page.navigate', { url: 'data:text/html,<h1 id=test>hello</h1>' }, sid).catch(e => ({ error: e.message }));
        await sleep(2000);
        const bodyCheck = await client1.cdp('Runtime.evaluate', {
          expression: 'document.body ? document.body.innerHTML.slice(0,100) : "no body"',
          returnByValue: true
        }, sid).catch(e => ({ result: { value: 'eval-failed: ' + e.message } }));
        console.log(`    [diag] navigate res=${JSON.stringify(navRes).slice(0,60)}, body=${bodyCheck?.result?.value?.slice(0,60)}`);
        const titleRes = bodyCheck;
        record('navigate + DOM 读取', titleRes?.result?.value?.includes('hello'), `body=${titleRes?.result?.value?.slice(0,40)}`);

        // screencast: captureScreenshot
        const shot = await client1.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 50 }, sid).catch(e => ({ error: e.message }));
        record('Page.captureScreenshot', !!shot?.data, shot?.error || `data length=${shot?.data?.length || 0}`);

        // insertText
        await client1.cdp('Runtime.evaluate', { expression: 'document.body.innerHTML="<input id=x>";document.getElementById("x").focus()' }, sid).catch(() => {});
        await client1.cdp('Input.insertText', { text: 'hello' }, sid).catch(() => {});
        await sleep(300);
        const inputVal = await client1.cdp('Runtime.evaluate', {
          expression: 'document.getElementById("x").value', returnByValue: true
        }, sid).catch(() => ({ result: { value: '' } }));
        record('Input.insertText', inputVal?.result?.value === 'hello', `value=${inputVal?.result?.value}`);

        // keyboard（需 ensureVisible）——用 text 参数让 keyDown 直接输入字符
        await client1.cdp('Runtime.evaluate', { expression: 'document.getElementById("x").focus()' }, sid).catch(() => {});
        await client1.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' }, sid).catch(() => {});
        await client1.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, sid).catch(() => {});
        await sleep(300);
        const afterKey = await client1.cdp('Runtime.evaluate', {
          expression: 'document.getElementById("x").value', returnByValue: true
        }, sid).catch(() => ({ result: { value: '' } }));
        record('Input.dispatchKeyEvent', afterKey?.result?.value?.includes('a'), `value=${afterKey?.result?.value}`);
      }
    }

    // === 场景 2: 同一端口多客户端共享 tab ===
    console.log('\n▼ 场景 2: 同一端口多客户端共享 tab');
    const client2 = makeClient(CREATE_A);
    await client2.open;
    // client2 应该能看到 client1 创建的 tab（对齐原生 Chrome）
    const tg2 = await client2.cdp('Target.getTargets').catch(e => ({ error: e.message }));
    const pages2 = (tg2?.targetInfos || []).filter(t => t.type === 'page');
    const seesSameTab = ct?.targetId ? pages2.some(p => p.targetId === ct.targetId) : false;
    record('Client2 能看到 Client1 的 tab', seesSameTab, `pages=${pages2.length}, hasTarget=${seesSameTab}`);

    // === 场景 3: 断开后 tab 仍存活 ===
    console.log('\n▼ 场景 3: 断开后 tab 仍存活');
    client1.ws.close();
    await sleep(1000);

    // 新 client 连同一端口，应能看到旧 tab
    const client3 = makeClient(CREATE_A);
    await client3.open;
    const tg3 = await client3.cdp('Target.getTargets').catch(e => ({ error: e.message }));
    const pages3 = (tg3?.targetInfos || []).filter(t => t.type === 'page');
    const tabSurvived = ct?.targetId ? pages3.some(p => p.targetId === ct.targetId) : false;
    record('断开后 tab 仍存活（新 client 可见）', tabSurvived, `pages=${pages3.length}`);

    // === 场景 4: 端口隔离仍生效 ===
    console.log('\n▼ 场景 4: 端口隔离');
    const clientB = makeClient(CREATE_B);
    await clientB.open;
    const tgB = await clientB.cdp('Target.getTargets').catch(e => ({ error: e.message }));
    const pagesB = (tgB?.targetInfos || []).filter(t => t.type === 'page');
    const bSeesA = ct?.targetId ? pagesB.some(p => p.targetId === ct.targetId) : false;
    record('PORT_B 看不到 PORT_A 的 tab', !bSeesA, bSeesA ? 'VISIBLE!' : 'isolated');

    // 清理
    client2.ws.close();
    client3.ws.close();
    clientB.ws.close();
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    failed++;
  } finally {
    if (chromeProc) {
      try { process.kill(-chromeProc.pid); } catch {}
      try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {}
    }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
