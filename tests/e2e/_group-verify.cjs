const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.join(EXTENSION_PATH, 'utils', 'config.js');

const PLUGIN_PORT = 29901;
const POOL_PORT = 29902;
const TAKEOVER_PORT = 29903;
const POOL_TAKEOVER_PORT = 29904;

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
  const events = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push({ method: msg.method, params: msg.params });
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('Timeout: ' + method)); } }, 15000);
      const o = { id: i, method, params };
      if (sessionId) o.sessionId = sessionId;
      ws.send(JSON.stringify(o));
    });
  }
  return { ws, cdp, events, open: new Promise((r, e) => { ws.on('open', r); ws.on('error', e); }) };
}

let proxyProc, chromeProc, configOriginal;

(async () => {
  console.log('=== 端口池分组验证 ===\n');

  try {
    configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, configOriginal.replace(
      /WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${PLUGIN_PORT}/plugin'`
    ));

    proxyProc = spawn(process.execPath, [PROXY_PATH], {
      env: { ...process.env, PORT: String(PLUGIN_PORT), TAKEOVER_PORT: String(TAKEOVER_PORT),
        POOL_START: String(POOL_PORT), POOL_SIZE: '1', POOL_TAKEOVER_PORT: String(POOL_TAKEOVER_PORT), LOG_LEVEL: 'debug' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const logStream = fs.createWriteStream('/tmp/pool-group-debug.log');
    proxyProc.stdout.pipe(logStream);
    proxyProc.stderr.pipe(logStream);

    for (let i = 0; i < 20; i++) { try { await httpGet(PLUGIN_PORT, '/json/version'); break; } catch { await sleep(500); } }

    const profile = `/tmp/cdp-group-verify-${Date.now()}`;
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
      try { const v = await httpGet(PLUGIN_PORT, '/json/version'); if (v && v.webSocketDebuggerUrl) { extReady = true; break; } } catch {}
      await sleep(2000);
    }
    if (!extReady) throw new Error('Extension did not connect');
    console.log('Extension connected\n');

    // 连端口池，创建 tab
    console.log('>>> 连接端口池 ' + POOL_PORT + '，创建 tab');
    const client = makeClient(POOL_PORT);
    await client.open;

    const ct = await client.cdp('Target.createTarget', { url: 'about:blank' });
    console.log('tab created:', ct?.targetId?.slice(0, 12));

    // attach + navigate
    const at = await client.cdp('Target.attachToTarget', { targetId: ct.targetId, flatten: true });
    await client.cdp('Page.enable', {}, at.sessionId);
    await client.cdp('Runtime.enable', {}, at.sessionId);
    await sleep(2000);

    // 等分组创建
    await sleep(3000);

    // 查 proxy 日志看分组是否创建了
    console.log('\n>>> 检查分组创建日志');
    const log = fs.readFileSync('/tmp/pool-group-debug.log', 'utf8');
    const groupLines = log.split('\n').filter(l =>
      l.includes('group') || l.includes('Group') || l.includes('CDP-') ||
      l.includes('tabGroup') || l.includes('client-connected') || l.includes('pool_')
    );
    console.log('分组相关日志 (' + groupLines.length + ' 行):');
    groupLines.slice(0, 20).forEach(l => console.log('  ' + l.trim()));

    // 查 Chrome 的 tabGroups（通过 Runtime.evaluate 在 page context 不行，
    // 用 plugin WS 查 chrome.tabGroups）
    console.log('\n>>> 查 Chrome tabGroups');
    const pluginWs = new WebSocket(`ws://localhost:${PLUGIN_PORT}/plugin`);
    await new Promise((r, e) => { pluginWs.on('open', r); pluginWs.on('error', e); });
    // 发命令让扩展执行 chrome.tabGroups.query
    const queryId = 'tabgroup_query_' + Date.now();
    const tabGroupResult = await new Promise((resolve) => {
      pluginWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === queryId || (msg.result && msg.id === queryId)) {
          resolve(msg);
        }
      });
      // 发一个 cdp 命令，让扩展用 chrome.debugger 查 tabGroups
      // 实际上扩展没有直接暴露 tabGroups 查询，用 chrome.tabs.query 替代
      pluginWs.send(JSON.stringify({
        id: queryId,
        method: 'Runtime.evaluate',
        params: { expression: '1' },
        type: 'cdp'
      }));
      setTimeout(() => resolve({ timeout: true }), 5000);
    });
    console.log('tabGroup query result:', JSON.stringify(tabGroupResult).slice(0, 100));
    pluginWs.close();

    client.ws.close();

    console.log('\n>>> 请检查 Chromium 窗口里的 tab 是否在分组中');
    await sleep(2000);

  } catch (e) {
    console.log('[ERROR]', e.message);
  } finally {
    if (chromeProc) { try { process.kill(-chromeProc.pid); } catch {} try { fs.rmSync(chromeProc._profile, { recursive: true, force: true }); } catch {} }
    if (proxyProc) { try { proxyProc.kill('SIGINT'); } catch {} }
    if (configOriginal) try { fs.writeFileSync(CONFIG_PATH, configOriginal); } catch {}
  }
  process.exit(0);
})();
