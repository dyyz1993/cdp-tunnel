#!/usr/bin/env node
'use strict';

/**
 * Benchmark: agent-browser direct vs CDP Tunnel
 *
 * Runs same agent-browser commands twice:
 * 1. DIRECT: Chrome on port 9222 without tunnel
 * 2. TUNNEL: Chrome + extension + proxy on random port
 *
 * Measures and compares timing per command.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const SESSION = 'ab-benchmark';

let proxyProcess, chromeProcess, chromeDirect;

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runAB(cmd, timeout = 60000) {
  const start = Date.now();
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: result.trim(), ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      output: (err.stdout || '').toString().trim(),
      error: (err.stderr || '').toString().trim() || err.message,
      ms: Date.now() - start
    };
  }
}

async function startDirectChrome(port) {
  const profile = `/tmp/ab-direct-${Date.now()}`;
  chromeDirect = spawn(CHROME_PATH, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', 'about:blank'
  ], { detached: true, stdio: 'ignore' });

  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', resolve);
        }).on('error', reject);
      });
      log('SETUP', `Direct Chrome ready on :${port}`);
      return true;
    } catch { await sleep(500); }
  }
  return false;
}

async function startTunnel(port) {
  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, originalConfig.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));

  proxyProcess = spawn('node', [PROXY_PATH], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'error' },
    stdio: 'pipe'
  });

  for (let i = 0; i < 30; i++) {
    try {
      await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', resolve);
        }).on('error', reject);
      });
      break;
    } catch { await sleep(500); }
  }

  const profile = `/tmp/ab-tunnel-${Date.now()}`;
  chromeProcess = spawn(CHROME_PATH, [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });

  await sleep(8000);
  for (let i = 0; i < 20; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
      const id = Date.now();
      const r = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { ws.off('message', h); reject(); }, 5000);
        const h = data => { try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', h); resolve(m); } } catch {} };
        ws.on('message', h);
        ws.send(JSON.stringify({ id, method: 'Target.getTargets' }));
      });
      ws.close();
      if (r?.result?.targetInfos?.length > 0) { log('SETUP', `Tunnel ready on :${port}`); return true; }
    } catch { await sleep(3000); }
  }
  return false;
}

function cleanup() {
  if (chromeProcess) { try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {} }
  if (chromeDirect) { try { process.kill(-chromeDirect.pid, 'SIGKILL'); } catch {} }
  if (proxyProcess) { try { proxyProcess.kill('SIGINT'); } catch {} }
  try { execSync(`agent-browser kill --session ${SESSION}`, { timeout: 5000, stdio: 'pipe' }); } catch {}
  try { execSync(`agent-browser kill --session ${SESSION}-tunnel`, { timeout: 5000, stdio: 'pipe' }); } catch {}
  try { fs.writeFileSync(CONFIG_PATH, fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
}

function benchmark(label, commands) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(60)}`);
  const results = [];
  commands.forEach(({ name, cmd }) => {
    const r = runAB(cmd, 60000);
    const status = r.ok ? 'OK' : 'FAIL';
    console.log(`  ${status} ${name}: ${r.ms}ms`);
    if (!r.ok) console.log(`       error: ${(r.error || '').substring(0, 80)}`);
    results.push({ name, ok: r.ok, ms: r.ms });
  });
  return results;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  agent-browser: Direct vs CDP Tunnel Benchmark`);
  console.log(`${'='.repeat(60)}\n`);

  const DIRECT_PORT = 9225;
  const TUNNEL_PORT = 19250;

  const commands = [
    { name: 'get url', cmd: `agent-browser --session ${SESSION} get url` },
    { name: 'get title', cmd: `agent-browser --session ${SESSION} get title` },
    { name: 'open about:blank', cmd: `agent-browser --session ${SESSION} open about:blank` },
    { name: 'open example.com', cmd: `agent-browser --session ${SESSION} open https://example.com` },
    { name: 'get title (Example)', cmd: `agent-browser --session ${SESSION} get title` },
    { name: 'snapshot', cmd: `agent-browser --session ${SESSION} snapshot` },
    { name: 'click body', cmd: `agent-browser --session ${SESSION} click body` },
    { name: 'screenshot', cmd: `agent-browser --session ${SESSION} screenshot /tmp/ab-bench.png` },
  ];

  try {
    // ===== DIRECT =====
    execSync(`agent-browser kill --session ${SESSION} 2>/dev/null; true`, { timeout: 5000, stdio: 'pipe' });
    await startDirectChrome(DIRECT_PORT);
    const directConnect = runAB(`agent-browser --cdp ${DIRECT_PORT} --session ${SESSION} get url`, 30000);
    console.log(`  [CONNECT] direct: ${directConnect.ms}ms (${directConnect.ok ? 'OK' : directConnect.error})`);

    if (directConnect.ok) {
      const directResults = benchmark('  === DIRECT (no tunnel) ===', commands);
      execSync(`agent-browser kill --session ${SESSION} 2>/dev/null; true`, { timeout: 5000, stdio: 'pipe' });
      try { process.kill(-chromeDirect.pid, 'SIGKILL'); } catch {}

      // ===== TUNNEL =====
      execSync(`agent-browser kill --session ${SESSION} 2>/dev/null; true`, { timeout: 5000, stdio: 'pipe' });
      if (!await startTunnel(TUNNEL_PORT)) throw new Error('Tunnel setup failed');
      const tunnelConnect = runAB(`agent-browser --cdp ${TUNNEL_PORT} --session ${SESSION} get url`, 30000);
      console.log(`  [CONNECT] tunnel: ${tunnelConnect.ms}ms (${tunnelConnect.ok ? 'OK' : (tunnelConnect.error || '').substring(0,60)})`);

      if (tunnelConnect.ok) {
        const tunnelResults = benchmark('  === TUNNEL (CDP Tunnel) ===', commands);

        // ===== COMPARISON =====
        console.log(`\n${'='.repeat(60)}`);
        console.log(`  COMPARISON SUMMARY`);
        console.log(`${'='.repeat(60)}`);
        console.log(`  ${'Command'.padEnd(28)} ${'Direct'.padEnd(10)} ${'Tunnel'.padEnd(10)} ${'Ratio'}`);
        console.log(`  ${'-'.repeat(58)}`);
        directResults.forEach((d, i) => {
          const t = tunnelResults[i];
          if (!d || !t) return;
          const dStr = d.ok ? `${d.ms}ms` : 'FAIL';
          const tStr = t.ok ? `${t.ms}ms` : 'FAIL';
          const ratio = d.ok && t.ok && d.ms > 0 ? `${(t.ms / d.ms).toFixed(1)}x` : '-';
          console.log(`  ${d.name.padEnd(28)} ${dStr.padEnd(10)} ${tStr.padEnd(10)} ${ratio}`);
        });
      } else {
        log('FAIL', 'Tunnel connect failed — see above');
      }
    } else {
      log('FAIL', 'Direct connect failed — cannot compare');
    }

  } catch (err) {
    console.error('FATAL:', err.message);
  }

  cleanup();
  console.log(`\n${'='.repeat(60)}\n`);
}

main();
