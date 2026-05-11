#!/usr/bin/env node
'use strict';

/**
 * Stress test: 3+ CDP clients, 10+ ops each, verify no cross-talk
 *
 * Each client creates/closes/switches tabs.
 * At each checkpoint: verify client only sees own tabs.
 * After all done: verify all CDP tabs cleaned, no leaks.
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 10000 + Math.floor(Math.random() * 50000);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null, chromeProcess = null, configOriginal = null;
let passed = 0, failed = 0;

function log(tag, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function patchConfig(p) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${p}/plugin'`));
}
function restoreConfig() { if (configOriginal) fs.writeFileSync(CONFIG_PATH, configOriginal); }

function send(ws, method, params = {}) {
  const id = Date.now() + Math.floor(Math.random() * 100000);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.off('message', h); rej(new Error(`T:${method}`)); }, 20000);
    const h = d => { try { const m = JSON.parse(d.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', h); res(m); } } catch {} };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitForProxy(p) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await new Promise((res, rej) => {
        http.get(`http://localhost:${p}/json/version`, r2 => { let d = ''; r2.on('data', c => d += c); r2.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } }); }).on('error', rej);
      });
      if (r) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForExtension(p) {
  await sleep(8000);
  for (let i = 0; i < 20; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${p}/client`);
      await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
      const r = await Promise.race([send(ws, 'Target.getTargets'), new Promise((_, j) => setTimeout(() => j(), 8000))]);
      ws.close();
      if (r?.result?.targetInfos?.length > 0) return true;
    } catch {}
    await sleep(3000);
  }
  return false;
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  restoreConfig();
}

function assert(cond, msg) {
  if (cond) { log('PASS', msg); passed++; }
  else { log('FAIL', msg); failed++; }
}

async function getPageTargets(ws, label) {
  const r = await send(ws, 'Target.getTargets');
  const pages = (r?.result?.targetInfos || []).filter(t => t.type === 'page');
  log(label, `Target.getTargets → ${pages.length} pages`);
  pages.forEach(p => log(label, `  ${p.targetId.substring(0, 16)} — ${p.url.substring(0, 40)}`));
  return pages;
}

async function getTabGroupInfo(ws) {
  const r = await send(ws, 'Tab.getGroupInfo');
  return r?.result || {};
}

async function run() {
  console.log(`\n=== Stress Test: 3 Clients × 10+ Ops (port ${PORT}) ===\n`);

  try {
    patchConfig(PORT);
    proxyProcess = spawn('node', [PROXY_PATH], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
    if (!await waitForProxy(PORT)) throw new Error('Proxy failed');

    const profile = `/tmp/cdp-stress-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });

    if (!await waitForExtension(PORT)) throw new Error('Extension failed');
    log('SETUP', 'Ready');

    // ── Connect 3 clients ──
    const clients = [];
    for (let c = 0; c < 3; c++) {
      const ws = new WebSocket(`ws://localhost:${PORT}/client`);
      await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
      await send(ws, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await sleep(1000);
      const info = await getTabGroupInfo(ws);
      clients.push({ ws, label: `CLIENT_${'ABC'[c]}`, groupId: info.groupId, tabIds: [] });
      log(clients[c].label, `Connected, groupId=${info.groupId || 'null'}`);
    }
    await sleep(2000);

    // ── Phase 1: Each client creates 4 tabs ──
    log('PHASE1', 'Each client creates 4 tabs...');
    for (const c of clients) {
      for (let t = 0; t < 4; t++) {
        const r = await send(c.ws, 'Target.createTarget', { url: 'about:blank' });
        const tid = r?.result?.targetId;
        if (tid) c.tabIds.push(tid);
        log(c.label, `  Created tab ${t+1}/4: ${tid?.substring(0, 16)}`);
        await sleep(300);
      }
      await sleep(2000);
      const g = await getTabGroupInfo(c.ws);
      log(c.label, `  GroupInfo: groupId=${g.groupId || 'null'}, ${c.tabIds.length} tabs`);
    }
    await sleep(3000);

    // ── Verify Phase 1: isolation ──
    log('CHECK', 'Verifying isolation after Phase 1...');
    for (const c of clients) {
      const pages = await getPageTargets(c.ws, c.label);
      const ownCount = pages.filter(p => c.tabIds.includes(p.targetId)).length;
      assert(ownCount === c.tabIds.length, `${c.label}: sees ${ownCount}/${c.tabIds.length} own tabs`);
      const otherCount = clients.filter(o => o !== c)
        .reduce((sum, o) => sum + pages.filter(p => o.tabIds.includes(p.targetId)).length, 0);
      assert(otherCount === 0, `${c.label}: sees ${otherCount} other-client tabs (want 0)`);
    }

    // ── Phase 2: Each client closes 2 tabs, creates 2 more ──
    log('PHASE2', 'Each client closes 2 tabs, creates 2 more...');
    for (const c of clients) {
      const toClose = c.tabIds.splice(0, 2);
      for (const tid of toClose) {
        await send(c.ws, 'Target.closeTarget', { targetId: tid });
        log(c.label, `  Closed: ${tid.substring(0, 16)}`);
        await sleep(200);
      }
      for (let t = 0; t < 2; t++) {
        const r = await send(c.ws, 'Target.createTarget', { url: 'about:blank' });
        if (r?.result?.targetId) c.tabIds.push(r.result.targetId);
        await sleep(300);
      }
      await sleep(2000);
    }

    // ── Verify Phase 2 ──
    log('CHECK', 'Verifying isolation after Phase 2...');
    for (const c of clients) {
      const pages = await getPageTargets(c.ws, c.label);
      const ownCount = pages.filter(p => c.tabIds.includes(p.targetId)).length;
      assert(ownCount === c.tabIds.length, `${c.label}: sees ${ownCount}/${c.tabIds.length} own tabs (after close+create)`);
      const otherCount = clients.filter(o => o !== c)
        .reduce((sum, o) => sum + pages.filter(p => o.tabIds.includes(p.targetId)).length, 0);
      assert(otherCount === 0, `${c.label}: ${otherCount} other-client tabs (want 0)`);
    }

    // ── Phase 3: Interleaved operations ──
    log('PHASE3', 'Interleaved operations: create, close, group check...');
    for (let round = 0; round < 3; round++) {
      for (const c of clients) {
        if (c.tabIds.length > 0) {
          const closeId = c.tabIds.shift();
          await send(c.ws, 'Target.closeTarget', { targetId: closeId });
        }
        const r = await send(c.ws, 'Target.createTarget', { url: 'about:blank' });
        if (r?.result?.targetId) c.tabIds.push(r.result.targetId);
        await sleep(200);
      }
    }
    await sleep(3000);

    // ── Verify Phase 3 ──
    log('CHECK', 'Final isolation verification...');
    for (const c of clients) {
      const pages = await getPageTargets(c.ws, c.label);
      const ownCount = pages.filter(p => c.tabIds.includes(p.targetId)).length;
      assert(ownCount >= Math.min(c.tabIds.length, pages.length),
        `${c.label}: final check sees ${ownCount}/${c.tabIds.length} own tabs`);
      
      const leaks = pages.filter(p =>
        clients.filter(o => o !== c).some(o => o.tabIds.includes(p.targetId))
      );
      assert(leaks.length === 0, `${c.label}: ${leaks.length} other-client tabs leaked`);
    }

    // ── Phase 4: Group validation ──
    log('PHASE4', 'Checking group IDs are unique per client...');
    const groupIds = new Set();
    for (const c of clients) {
      const info = await getTabGroupInfo(c.ws);
      log(c.label, `  Group: ${info.groupId}, baseName: ${info.baseName}`);
      if (info.groupId) groupIds.add(info.groupId);
    }
    assert(groupIds.size === clients.length, `${groupIds.size}/${clients.length} unique groups (each client should have its own)`);

    // ── Phase 5: Kill one client, verify others unaffected ──
    log('PHASE5', 'Killing client A, verifying B and C unaffected...');
    clients[0].ws.close();
    await sleep(8000);

    for (let i = 1; i < clients.length; i++) {
      const c = clients[i];
      const pages = await getPageTargets(c.ws, c.label);
      const ownCount = pages.filter(p => c.tabIds.includes(p.targetId)).length;
      assert(ownCount === c.tabIds.length, `${c.label}: after A killed, sees ${ownCount}/${c.tabIds.length} own tabs`);
    }

    // ── Phase 6: Kill remaining ──
    log('PHASE6', 'Killing B, C and verifying cleanup...');
    for (let i = 1; i < clients.length; i++) {
      clients[i].ws.close();
    }
    await sleep(10000);

    // Verify all cleaned up
    const checkWs = new WebSocket(`ws://localhost:${PORT}/client`);
    await new Promise((r, e) => { checkWs.on('open', r); checkWs.on('error', e); });
    const finalPages = await getPageTargets(checkWs, 'FINAL');
    checkWs.close();

    assert(finalPages.length === 0, `After all disconnected: ${finalPages.length} pages (want 0)`);

  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
  } finally {
    cleanup();
  }

  console.log(`\n=== STRESS TEST: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
