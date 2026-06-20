const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PLUGIN_PORT = 29601;
const POOL_PORT_A = 29602;
const POOL_PORT_B = 29603;
const TAKEOVER_PORT = 29604;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

function makeClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}/client`);
  const pending = new Map();
  let id = 1;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('Timeout: ' + method)); } }, 15000);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  return { ws, cdp, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

// 通过 plugin WS 发 Runtime.evaluate 到扩展 SW，查 chrome.tabGroups
function queryTabGroups(pluginPort) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${pluginPort}/plugin`);
    let resolved = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      // 扩展会发 CDPTunnel.debug 事件带 groupCreated 信息
      if (msg.method === 'CDPTunnel.debug' && msg.params?.phase === 'groupCreated') {
        if (!resolved) { resolved = true; resolve(msg.params); }
      }
    });
    ws.on('open', () => {
      // 发 client-connected 触发查询（如果有逻辑的话）
      // 实际上我们靠 groupCreated 事件来确认
    });
    setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } ws.close(); }, 8000);
  });
}

let proxyProc, chromeProc, configOriginal;
let passed = 0, failed = 0;

function record(label, pass, detail) {
  if (pass) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log(`\n=== 端口池分组名验证 ===\n`);

  try {
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PLUGIN_PORT), TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(POOL_PORT_A), POOL_SIZE: '2', POOL_TAKEOVER_PORT: String(TAKEOVER_PORT), LOG_LEVEL: 'debug' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const logPath = '/tmp/pool-group-title-test.log';
    const logStream = fs.createWriteStream(logPath);
    proxyProc.stdout.pipe(logStream);
    proxyProc.stderr.pipe(logStream);

    for (let i = 0; i < 20; i++) { try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); } }

    const profile = `/tmp/cdp-gt-${Date.now()}`;
    chromeProc = spawn(CHROME_PATH, [
      `--user-data-dir=${profile}`, `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider', 'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProc._profile = profile;
    await sleep(4000);

    let extReady = false;
    for (let i = 0; i < 90; i++) {
      try { const v = await httpGet(PLUGIN_PORT, '/json/version'); if (v && v.webSocketDebuggerUrl) { extReady = true; break; } } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension connected\n');

    // 监听 plugin 上的 groupCreated 事件
    const groupEvents = [];
    const pluginWs = new WebSocket(`ws://localhost:${PLUGIN_PORT}/plugin`);
    pluginWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'CDPTunnel.debug' && msg.params?.baseName) {
        groupEvents.push({ baseName: msg.params.baseName, clientId: msg.params.clientId });
      }
    });
    await new Promise((r, e) => { pluginWs.on('open', r); pluginWs.on('error', e); });

    // 端口 A 创建 tab
    console.log('>>> 端口 A (' + POOL_PORT_A + ') 创建 tab');
    const clientA = makeClient(POOL_PORT_A);
    await clientA.open;
    await clientA.cdp('Target.createTarget', { url: 'https://www.example.com' });
    await sleep(5000);

    // 端口 B 创建 tab
    console.log('>>> 端口 B (' + POOL_PORT_B + ') 创建 tab');
    const clientB = makeClient(POOL_PORT_B);
    await clientB.open;
    await clientB.cdp('Target.createTarget', { url: 'https://www.example.org' });
    await sleep(5000);

    // 验证
    console.log('\n=== 分组名验证 ===\n');

    // 从 proxy 日志找 baseName
    const log = fs.readFileSync(logPath, 'utf8');
    const baseNameLines = log.split('\n')
      .filter(l => l.includes('baseName'))
      .map(l => { const m = l.match(/baseName.*?"(CDP-[^"]+)"/); return m ? m[1] : null; })
      .filter(Boolean);

    const hasPortA = baseNameLines.some(n => n.includes(String(POOL_PORT_A)));
    const hasPortB = baseNameLines.some(n => n.includes(String(POOL_PORT_B)));
    const hasLocal = baseNameLines.some(n => n.includes('local'));

    record(`端口 A 分组名包含 ${POOL_PORT_A}`, hasPortA, baseNameLines.find(n => n.includes(String(POOL_PORT_A))));
    record(`端口 B 分组名包含 ${POOL_PORT_B}`, hasPortB, baseNameLines.find(n => n.includes(String(POOL_PORT_B))));
    record('分组名不含 local', !hasLocal, hasLocal ? '发现了 local！' : '全部用端口号');

    // groupCreated 事件验证
    record('至少 2 个分组创建', groupEvents.length >= 2 || baseNameLines.length >= 2, `events=${groupEvents.length} baseNames=${baseNameLines.length}`);

    clientA.ws.close();
    clientB.ws.close();
    pluginWs.close();

  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    failed++;
  } finally {
    if (chromeProc) { try { process.kill(-chromeProc.pid); } catch {} try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {} }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {} 
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
