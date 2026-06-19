/**
 * WebSocket 代理服务器
 * 用于连接 Chrome 扩展 (CDP) 和 Playwright/Puppeteer 客户端
 *
 * 功能:
 * - 单端口 9221，通过路径区分连接类型
 * - /plugin 路径: 接收 Chrome 扩展的 CDP 连接
 * - /client 路径: 接收 Playwright/Puppeteer 客户端连接
 * - 双向透传消息
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn: spawnProcess } = require('child_process');
const { CONFIG, BROWSER_ID, shouldLog } = require('./modules/config');
const { PortPoolManager } = require('./modules/port-pool');
const TAKEOVER_PORT = CONFIG.TAKEOVER_PORT;

// v3.0 端口池（提前声明，后面初始化）
let portPool = null;
const { logCDP, logEvent, clearLog, logStatus, logConnectionEvent, flushAllLogs, logDisconnect } = require('./modules/logger');

try {
    const { validateApiKey } = require('./saas/auth');
    var HAS_SAAS = true;
} catch (e) {
    var HAS_SAAS = false;
}

const PORT = CONFIG.PORT;
const CONFIG_DIR = path.join(os.homedir(), '.cdp-tunnel');
const INSTANCE_DIR = path.join(CONFIG_DIR, 'instances', PORT.toString());

if (!fs.existsSync(INSTANCE_DIR)) {
    fs.mkdirSync(INSTANCE_DIR, { recursive: true });
}

const EXTENSION_STATE_FILE = path.join(INSTANCE_DIR, 'extension-state.json');
const PLUGIN_EVER_CONNECTED_FILE = path.join(INSTANCE_DIR, 'plugin-ever-connected');
const SERVER_START_TIME = Date.now();

let lastChromeRestartAttempt = 0;
const CHROME_RESTART_COOLDOWN = CONFIG.CHROME_RESTART_COOLDOWN;
const autoRestartEnabled = CONFIG.AUTO_RESTART;

function findChromePath() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    const platform = os.platform();
    const candidates = {
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ],
        linux: [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
        ],
    };
    const paths = candidates[platform] || [];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function isChromeRunning() {
    const platform = os.platform();
    try {
        if (platform === 'darwin') {
            const result = execSync('pgrep -x "Google Chrome" || pgrep -x "Chromium" || true', { encoding: 'utf8' });
            return result.trim().length > 0;
        }
        if (platform === 'win32') {
            const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
            return result.includes('chrome.exe');
        }
        const result = execSync('pgrep -f "chrome|chromium" || true', { encoding: 'utf8' });
        return result.trim().length > 0;
    } catch { return false; }
}

function tryAutoRestartChrome() {
    if (!autoRestartEnabled) return false;

    const now = Date.now();
    if (now - lastChromeRestartAttempt < CHROME_RESTART_COOLDOWN) {
        console.log('[AUTO-RESTART] Cooldown active, skipping restart');
        return false;
    }
    lastChromeRestartAttempt = now;

    if (isChromeRunning()) {
        console.log('[AUTO-RESTART] Chrome is already running. Cannot add extension to running Chrome.');
        console.log('[AUTO-RESTART] Please click the CDP Bridge extension icon to connect.');
        return false;
    }

    const chromePath = findChromePath();
    if (!chromePath) {
        console.log('[AUTO-RESTART] Chrome not found. Set CHROME_PATH env var.');
        return false;
    }

    const extensionPath = path.join(__dirname, '..', 'extension-new');
    if (!fs.existsSync(extensionPath)) {
        console.log('[AUTO-RESTART] Extension directory not found:', extensionPath);
        return false;
    }

    try {
        const platform = os.platform();
        if (platform === 'darwin') {
            const appName = chromePath.replace(/\/Contents\/MacOS\/.*$/, '');
            execSync(`open -a "${appName}" --args --load-extension="${extensionPath}"`, {
                timeout: 10000,
                stdio: 'ignore',
            });
        } else {
            spawnProcess(chromePath, [`--load-extension=${extensionPath}`], {
                detached: true,
                stdio: 'ignore',
            }).unref();
        }
        console.log('[AUTO-RESTART] Chrome launched with extension:', chromePath);
        return true;
    } catch (err) {
        console.error('[AUTO-RESTART] Failed to launch Chrome:', err.message);
        return false;
    }
}

function updateExtensionState(connected) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(EXTENSION_STATE_FILE, JSON.stringify({
            connected: connected,
            lastSeen: Date.now()
        }));
    } catch (e) {}
}

clearLog();

const wss = new WebSocket.Server({ noServer: true });
const server = http.createServer((req, res) => handleHttpRequest(req, res));

const pluginConnections = new Set();
const clientConnections = new Set();

class PluginNamespace {
    constructor() {
        this.sessionToClientId = new Map();
        this.pendingAttachRequests = new Map();
        this.pendingAttachedEvents = new Map();
        this.pendingTargetCreatedEvents = new Map();
        this.targetIdToClientId = new Map();
        this.browserContextToClientId = new Map();
        this.clientIdToBrowserContext = new Map();
        this.cachedTargets = [];
        this.lastTargetsUpdate = 0;
        this.cachedBrowserVersion = null;
        this.discoveringClientIds = new Map();
    }
}

const pluginNamespaces = new Map();

function getNamespace(pluginWs) {
    if (!pluginNamespaces.has(pluginWs)) {
        pluginNamespaces.set(pluginWs, new PluginNamespace());
    }
    return pluginNamespaces.get(pluginWs);
}

const connectionPairs = new Map();
const clientById = new Map();
const clientIdToPlugin = new Map();
const globalRequestIdMap = new Map();
let globalRequestIdCounter = 0;

const { version: PKG_VERSION } = require('../package.json');

console.log('='.repeat(60));
console.log(`  WebSocket CDP Proxy Server v${PKG_VERSION}`);
console.log('='.repeat(60));
console.log(`  Server started on port ${PORT}`);
console.log(`  - Plugin path: ws://localhost:${PORT}/plugin`);
console.log(`  - Client path: ws://localhost:${PORT}/client`);
console.log(`  - CDP endpoint: http://localhost:${PORT}`);
console.log(`  - Takeover port: ${TAKEOVER_PORT} (mode=takeover)`);
console.log(`  - Takeover CDP:  http://localhost:${TAKEOVER_PORT}`);
console.log('='.repeat(60));

/**
 * 获取请求的 Host
 */
function getHost(req) {
    return req.headers.host || `localhost:${PORT}`;
}

function invalidateTargetsCache(pluginWs) {
    if (pluginWs) {
        getNamespace(pluginWs).lastTargetsUpdate = 0;
    } else {
        pluginNamespaces.forEach(ns => { ns.lastTargetsUpdate = 0; });
    }
}

async function requestVersionFromPlugin(pluginWs) {
    if (!pluginWs) {
        pluginWs = pluginConnections.values().next().value;
    }
    if (!pluginWs) return null;

    const ns = getNamespace(pluginWs);
    if (ns.cachedBrowserVersion) return ns.cachedBrowserVersion;

    if (pluginWs.readyState !== WebSocket.OPEN) {
        return null;
    }

    return new Promise((resolve) => {
        const requestId = `version_${Date.now()}`;
        const timeout = setTimeout(() => resolve(null), 2000);

        const handler = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === requestId && msg.result) {
                    clearTimeout(timeout);
                    pluginWs.off('message', handler);
                    if (msg.result.product || msg.result.userAgent) {
                        ns.cachedBrowserVersion = msg.result;
                    }
                    resolve(ns.cachedBrowserVersion || msg.result);
                }
            } catch (e) {}
        };

        pluginWs.on('message', handler);
        pluginWs.send(JSON.stringify({ id: requestId, method: 'Browser.getVersion' }));
    });
}

async function requestTargetsFromPlugin(pluginWs) {
    if (!pluginWs) {
        pluginWs = pluginConnections.values().next().value;
    }
    if (!pluginWs) return [];

    const ns = getNamespace(pluginWs);
    const now = Date.now();
    if (now - ns.lastTargetsUpdate < CONFIG.TARGETS_CACHE_TTL && ns.cachedTargets.length > 0) {
        return ns.cachedTargets;
    }

    if (pluginWs.readyState !== WebSocket.OPEN) {
        return ns.cachedTargets;
    }

    return new Promise((resolve) => {
        const requestId = `targets_${Date.now()}`;
        const timeout = setTimeout(() => {
            resolve(ns.cachedTargets);
        }, CONFIG.TARGETS_REQUEST_TIMEOUT);

        const handler = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === requestId && msg.result?.targetInfos) {
                    clearTimeout(timeout);
                    pluginWs.off('message', handler);
                    ns.cachedTargets = msg.result.targetInfos;
                    ns.lastTargetsUpdate = now;
                    resolve(ns.cachedTargets);
                }
            } catch (e) {}
        };

        pluginWs.on('message', handler);
        pluginWs.send(JSON.stringify({ id: requestId, method: 'Target.getTargets' }));
    });
}

/**
 * 生成指定 plugin 的 browser WS URL
 */
function buildBrowserWsUrl(pluginId) {
    const host = CONFIG.EXTERNAL_HOST || `localhost:${PORT}`;
    return `ws://${host}/devtools/browser/${pluginId}`;
}

/**
 * 处理 HTTP 请求
 */
function resolvePluginFromUrl(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 3) {
        const pluginId = parts[2];
        for (const pluginWs of pluginConnections) {
            if (pluginWs.pluginId === pluginId) return pluginWs;
        }
    }
    return pluginConnections.values().next().value || null;
}

async function handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    if (url.pathname === '/json/browsers' || url.pathname === '/json/browsers/') {
        const browsers = [];
        for (const pluginWs of pluginConnections) {
            if (pluginWs.readyState !== WebSocket.OPEN) continue;
            const ns = getNamespace(pluginWs);
            browsers.push({
                pluginId: pluginWs.pluginId,
                pluginName: pluginWs.pluginName || 'My Browser',
                userId: pluginWs.userId || null,
                browserName: ns.cachedBrowserVersion?.Browser || 'Unknown',
                targets: ns.cachedTargets.length,
                connected: true,
                connectedAt: pluginWs.connectedAt,
                webSocketDebuggerUrl: buildBrowserWsUrl(pluginWs.pluginId)
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(browsers));
        return;
    }
    
    if (url.pathname === '/json/version' || url.pathname === '/json/version/' ||
        url.pathname.match(/^\/json\/version\/[^/]+$/)) {
        const pluginWs = resolvePluginFromUrl(url);
        const ver = await requestVersionFromPlugin(pluginWs);
        const userAgent = ver?.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';
        const product = ver?.product || 'Chrome/131.0.6778.86';
        const browserId = pluginWs ? pluginWs.pluginId : BROWSER_ID;
        const payload = {
            Browser: `${product} (cdp-tunnel/${PKG_VERSION})`,
            'Protocol-Version': ver?.protocolVersion || '1.3',
            'User-Agent': userAgent,
            'V8-Version': ver?.jsVersion || '',
            'WebKit-Version': '537.36',
            webSocketDebuggerUrl: `ws://${getHost(req)}/devtools/browser/${browserId}`,
            totalPlugins: pluginConnections.size
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
    }
    
    if (url.pathname === '/json' || url.pathname === '/json/' ||
        url.pathname === '/json/list' || url.pathname === '/json/list/' ||
        url.pathname.match(/^\/json\/list\/[^/]+$/)) {
        // 注意：Playwright connectOverCDP 和 Puppeteer connect 都依赖 /json/list 发现 targets
        // HTTP 端无 clientId 上下文，无法做归属过滤，但 attach 路径（handlePageConnection）有归属校验
        // 所以即使列表可见，无归属 target 也无法被 attach（close 1008）
        const pluginWs = resolvePluginFromUrl(url);
        const targets = await requestTargetsFromPlugin(pluginWs);
        const browserId = pluginWs ? pluginWs.pluginId : BROWSER_ID;
        const targetList = targets
            .filter(t => {
                if (t.type !== 'page') return false;
                const tUrl = t.url || '';
                if (tUrl.startsWith('chrome://') || 
                    tUrl.startsWith('chrome-extension://') ||
                    tUrl.startsWith('devtools://') ||
                    tUrl.startsWith('edge://')) {
                    return false;
                }
                return true;
            })
            .map(t => ({
                description: '',
                devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${getHost(req)}/devtools/page/${t.targetId}`,
                devtoolsFrontendUrlCompat: `devtools://devtools/bundled/inspector.html?ws=${getHost(req)}/devtools/page/${t.targetId}`,
                faviconUrl: '',
                id: t.targetId,
                title: t.title || '',
                type: t.type,
                url: t.url || '',
                webSocketDebuggerUrl: `ws://${getHost(req)}/devtools/page/${t.targetId}`
            }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(targetList));
        return;
    }

    if (url.pathname === '/debug/maps') {
        const stats = {};
        for (const [pluginWs, ns] of pluginNamespaces) {
            stats.targetIdToClientId = ns.targetIdToClientId.size;
            stats.sessionToClientId = ns.sessionToClientId.size;
            stats.browserContextToClientId = ns.browserContextToClientId.size;
            stats.clientIdToBrowserContext = ns.clientIdToBrowserContext.size;
            stats.pendingAttachedEvents = ns.pendingAttachedEvents.size;
            stats.pendingTargetCreatedEvents = ns.pendingTargetCreatedEvents.size;
            stats.pendingSessionToClientId = (ns.pendingSessionToClientId || new Map()).size;
            stats.discoveringClientIds = ns.discoveringClientIds.size;
            stats.cachedTargets = ns.cachedTargets.length;
        }
        stats.globalRequestIdMap = globalRequestIdMap.size;
        stats.connectionPairs = connectionPairs.size;
        stats.clientById = clientById.size;
        stats.clientIdToPlugin = clientIdToPlugin.size;
        stats.clientConnections = clientConnections.size;
        stats.pluginConnections = pluginConnections.size;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats, null, 2));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
}

/**
 * 根据 upgrade 请求的 URL 路径区分连接类型
 */
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const pathParts = path.split('/').filter(Boolean);
    const isPlugin = path === '/plugin';
    const isClient = path === '/client' || 
                     path.startsWith('/client/') ||
                     path.startsWith('/client-') ||
                     path.startsWith('/devtools/browser/') ||
                     path.startsWith('/devtools/page/');

    if (!isPlugin && !isClient) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const pathParts = path.split('/').filter(Boolean);

    const clientInfo = {
        ip: req.socket.remoteAddress,
        port: req.socket.remotePort
    };

    if (path === '/plugin') {
        handlePluginConnection(ws, clientInfo, req);
    } else if (path === '/client' || path.startsWith('/client/') || path.startsWith('/client-') || path.startsWith('/devtools/browser/')) {
        const customClientId = path.startsWith('/client-') ? path.replace('/client-', '') : null;
        let targetPluginId = null;
        if (pathParts[0] === 'client' && pathParts[1]) {
            targetPluginId = pathParts[1];
        } else if (pathParts[0] === 'devtools' && pathParts[1] === 'browser' && pathParts[2]) {
            targetPluginId = pathParts[2];
        }
        const mode = req._takeoverMode ? 'takeover' : 'create';
        handleClientConnection(ws, clientInfo, customClientId, targetPluginId, mode);
    } else if (path.startsWith('/devtools/page/')) {
        const targetId = path.replace('/devtools/page/', '');
        const mode = req._takeoverMode ? 'takeover' : 'create';
        handlePageConnection(ws, clientInfo, targetId, mode);
    } else {
        console.log(`[REJECTED] Unknown path: ${path} from ${clientInfo.ip}:${clientInfo.port}`);
        ws.close(1008, 'Invalid path. Use /plugin or /client');
    }
});

function cleanupClient(ws, id, reason) {
    const pluginWs = ws.pairedPlugin || clientIdToPlugin.get(id);
    const ns = pluginWs ? getNamespace(pluginWs) : null;
    const isTakeover = ws.mode === 'takeover';

    if (ns) {
        const sessionsToClean = [];
        for (const [sessionId, clientId] of ns.sessionToClientId.entries()) {
            if (clientId === id) {
                sessionsToClean.push(sessionId);
                ns.sessionToClientId.delete(sessionId);
            }
        }
    }

    clientConnections.delete(ws);
    clientById.delete(id);
    clientIdToPlugin.delete(id);

    logConnectionEvent('CLIENT_DISCONNECTED', {
        id,
        reason,
        mode: ws.mode || 'create',
        totalPlugins: pluginConnections.size,
        totalClients: clientConnections.size
    });

    logDisconnect('CLIENT_CLEANUP', {
        clientId: id,
        reason,
        mode: ws.mode || 'create',
        cdpMethodsUsed: ws.cdpTrace ? [...new Set(ws.cdpTrace)] : [],
        uptime: ws.connectedAt ? `${((Date.now() - ws.connectedAt) / 1000).toFixed(0)}s` : 'unknown',
        remainingClients: clientConnections.size,
        pluginAlive: pluginConnections.size > 0,
        pairedPluginId: ws.pairedPlugin?.id || null
    });

    if (ws.cdpTrace && ws.cdpTrace.length && shouldLog('debug')) {
        const unique = [...new Set(ws.cdpTrace)];
        console.log(`[CDP TRACE] ${id} methods (${ws.cdpTrace.length}): ${unique.join(', ')}`);
    }

    if (ws.pairedPlugin) {
        if (isTakeover) {
            safeSend(ws.pairedPlugin, JSON.stringify({
                type: 'takeover-disconnect',
                clientId: id,
                sessions: []
            }), 'plugin');
            console.log(`[TAKEOVER DISCONNECT] client=${id} — detaching only, not closing tabs`);
        } else {
            const sendOk = safeSend(ws.pairedPlugin, JSON.stringify({
                type: 'client-disconnected',
                clientId: id,
                sessions: []
            }), 'plugin');
            if (!sendOk) {
                console.log(`[WARN] cleanupClient: failed to send client-disconnected for ${id} to plugin`);
            }

            const pluginNs = getNamespace(ws.pairedPlugin);
            if (pluginNs) {
                const targetsToClose = [];
                for (const [tId, cId] of pluginNs.targetIdToClientId.entries()) {
                    if (cId === id) {
                        targetsToClose.push(tId);
                    }
                }
                targetsToClose.forEach(function(tId) {
                    const closeReq = JSON.stringify({
                        id: -1,
                        method: 'Target.closeTarget',
                        params: { targetId: tId },
                        __clientId: id
                    });
                    safeSend(ws.pairedPlugin, closeReq, 'plugin');
                });
            }
        }
    }

    broadcastClientList();

    if (ns) {
        for (const [tId, cId] of ns.targetIdToClientId.entries()) {
            if (cId === id) ns.targetIdToClientId.delete(tId);
        }
        // session 清理：value 可能是 clientId（正常）或 targetId（旧 bug 残留，兼容清理）
        const clientTargetIds = new Set();
        for (const [tId, cId] of ns.targetIdToClientId.entries()) {
            if (cId === id) clientTargetIds.add(tId);
        }
        for (const [sId, val] of ns.sessionToClientId.entries()) {
            if (val === id || clientTargetIds.has(val)) {
                ns.sessionToClientId.delete(sId);
            }
        }
        // 清理 pending session（归属未定的暂存）
        if (ns.pendingSessionToClientId) {
            for (const [pSid, pTid] of ns.pendingSessionToClientId.entries()) {
                if (clientTargetIds.has(pTid)) ns.pendingSessionToClientId.delete(pSid);
            }
        }
        // 清理 pending 事件（targetCreated/attachedToTarget 缓存，防止泄漏）
        if (ns.pendingAttachedEvents) {
            for (const [pTid] of ns.pendingAttachedEvents.entries()) {
                if (clientTargetIds.has(pTid)) ns.pendingAttachedEvents.delete(pTid);
            }
        }
        if (ns.pendingTargetCreatedEvents) {
            for (const [pTid] of ns.pendingTargetCreatedEvents.entries()) {
                if (clientTargetIds.has(pTid)) ns.pendingTargetCreatedEvents.delete(pTid);
            }
        }
        for (const [bcId, cId] of ns.browserContextToClientId.entries()) {
            if (cId === id) ns.browserContextToClientId.delete(bcId);
        }
        if (ns.clientIdToBrowserContext.has(id)) {
            ns.clientIdToBrowserContext.delete(id);
        }
        ns.discoveringClientIds.delete(id);
    }
    for (const [gId, mapping] of globalRequestIdMap.entries()) {
        if (mapping.clientId === id) globalRequestIdMap.delete(gId);
    }

    if (ws.pairedPlugin) {
        ws.pairedPlugin.pairedClientId = null;
    }
    connectionPairs.delete(id);
}

function sendPendingRequestErrors(pluginWs) {
    const toDelete = [];
    for (const [gId, mapping] of globalRequestIdMap.entries()) {
        const clientWs = clientById.get(mapping.clientId);
        if (clientWs && clientWs.pairedPlugin === pluginWs) {
            const errorResponse = {
                id: mapping.originalId,
                error: { code: -32000, message: 'Plugin disconnected: request cancelled' }
            };
            if (mapping.sessionId) {
                errorResponse.sessionId = mapping.sessionId;
            }
            safeSend(clientWs, JSON.stringify(errorResponse), 'client');
            toDelete.push(gId);
        }
    }
    toDelete.forEach(gId => globalRequestIdMap.delete(gId));
}

function cleanupPlugin(ws, id, reason) {
    const ns = getNamespace(ws);
    pluginConnections.delete(ws);
    pluginNamespaces.delete(ws);

    if (pluginConnections.size === 0) {
        updateExtensionState(false);
    }

    sendPendingRequestErrors(ws);

    const affectedClients = [];
    clientConnections.forEach(clientWs => {
        if (clientWs.pairedPlugin === ws) {
            if (clientWs.pluginMessageHandler) {
                ws.off('message', clientWs.pluginMessageHandler);
                clientWs.pluginMessageHandler = null;
            }
            clientWs.pairedPlugin = null;
            affectedClients.push(clientWs.id);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                    type: 'plugin-disconnected',
                    message: 'Plugin connection lost'
                }));
            }
        }
    });

    logDisconnect('PLUGIN_CLEANUP', {
        pluginId: id,
        reason,
        remainingPlugins: pluginConnections.size,
        affectedClients,
        uptime: ws.connectedAt ? `${((Date.now() - ws.connectedAt) / 1000).toFixed(0)}s` : 'unknown',
        activeSessions: ns.sessionToClientId.size,
        pendingRequests: ns.pendingAttachRequests.size
    });

    if (ws.pairedClientId) {
        connectionPairs.delete(ws.pairedClientId);
    }
}

/**
 * 处理 Chrome 扩展连接
 */
function handlePluginConnection(ws, clientInfo, request) {
    const req = request;
    const id = generateId('plugin');
    
    ws.pluginId = 'browser_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

    try {
        const url = new URL(req.url, `http://localhost`);
        const apiKey = url.searchParams.get('key');
        const desiredPluginId = url.searchParams.get('pluginId');

        if (desiredPluginId && /^browser_[a-zA-Z0-9_]+$/.test(desiredPluginId)) {
            let conflict = false;
            for (const existing of pluginConnections) {
                if (existing.pluginId === desiredPluginId && existing !== ws) {
                    conflict = true;
                    break;
                }
            }
            if (!conflict) {
                ws.pluginId = desiredPluginId;
            }
        }

        if (HAS_SAAS && apiKey) {
            const keyInfo = validateApiKey(apiKey);
            if (keyInfo) {
                ws.userId = keyInfo.userId;
                ws.apiKeyId = keyInfo.keyId;
                logConnectionEvent('PLUGIN_AUTHED', `userId=${keyInfo.userId} keyName=${keyInfo.keyName}`);
            } else {
                logConnectionEvent('PLUGIN_AUTH_FAIL', 'Invalid API key');
                ws.close(4001, 'Invalid API key');
                return;
            }
        }
    } catch (e) {
        logConnectionEvent('PLUGIN_AUTH_ERR', e.message);
    }
    
    pluginConnections.add(ws);
    
    const pluginType = 'plugin';
    
    if (shouldLog('info')) {
        console.log(`\n[PLUGIN CONNECTED] ID: ${id}`);
        console.log(`  - Remote: ${clientInfo.ip}:${clientInfo.port}`);
        console.log(`  - Total plugin connections: ${pluginConnections.size}`);
    }
    
    logConnectionEvent('PLUGIN_CONNECTED', {
        id,
        ip: clientInfo.ip,
        port: clientInfo.port,
        totalPlugins: pluginConnections.size,
        totalClients: clientConnections.size
    });
    
    updateExtensionState(true);

    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        if (!fs.existsSync(PLUGIN_EVER_CONNECTED_FILE)) {
            fs.writeFileSync(PLUGIN_EVER_CONNECTED_FILE, new Date().toISOString());
        }
    } catch {}

    // 如果有待配对的客户端，自动配对
    if (clientConnections.size > 0) {
        for (const clientWs of clientConnections) {
            if (!connectionPairs.has(clientWs.id)) {
                connectionPairs.set(clientWs.id, ws);
                ws.pairedClientId = clientWs.id;
                clientWs.pairedPlugin = ws;
                if (shouldLog('info')) {
                    console.log(`  - Paired with client: ${clientWs.id}`);
                }
                logConnectionEvent('PLUGIN_PAIRED', { pluginId: id, clientId: clientWs.id });
                break;
            }
        }
    }

    ws.id = id;
    ws.isAlive = true;
    ws.pluginType = pluginType;
    
    // 发送当前客户端列表给新连接的插件
    const clients = [];
    clientConnections.forEach((client) => {
        clients.push({
            id: client.id,
            connectedAt: client.connectedAt,
            lastActivity: client.lastActivityTime
        });
    });
    ws.send(JSON.stringify({
        type: 'client-list',
        clients: clients
    }));

    // 心跳检测
    ws.on('pong', () => {
        ws.isAlive = true;
        logConnectionEvent('HEARTBEAT_PONG', { type: 'plugin', id: ws.id });
    });

    // 消息转发: Plugin -> Client
    ws.on('message', (data) => {
        console.log(`[PLUGIN MESSAGE] size=${data.length}`);

        const messageSize = data.length;
        let messagePreview;
        let parsed;
        try {
            parsed = JSON.parse(data);
            messagePreview = parsed.method || parsed.id || 'response';
        } catch {
            parsed = null;
            messagePreview = `binary (${messageSize} bytes)`;
        }

        if (shouldLog('debug')) {
            console.log(`[PLUGIN -> CLIENT] ${id}: ${messagePreview}`);
        }

        // v3.0 端口池 hook：先让 PortPoolManager 处理端口池的消息
        if (parsed && portPool && portPool.handlePluginMessage(parsed, ws)) {
            return;
        }

        // 处理 keepalive 消息
        if (parsed && parsed.type === 'keepalive') {
            ws.isAlive = true;
            logConnectionEvent('KEEPALIVE_RECEIVED', { type: 'plugin', id: ws.id });
            return;
        }

        if (parsed && parsed.type === 'plugin-hello') {
            const extVersion = parsed.version || 'unknown';
            ws.extVersion = extVersion;
            const match = extVersion === PKG_VERSION;
            const level = match ? 'info' : 'warn';
            const label = match ? '✅' : '⚠️ VERSION MISMATCH';
            const msg = `[VERSION CHECK] ${label} server=${PKG_VERSION} extension=${extVersion}`;
            console.log(msg);
            logCDP('VERSION', msg);
            if (!match) {
                console.log(`  ↳ Run "cdp-tunnel update" or reload the extension to sync versions`);
            }
            getNamespace(ws).cachedBrowserVersion = null;
            requestVersionFromPlugin(ws);
            return;
        }
        
        console.log(`[PLUGIN MSG] id=${parsed?.id} method=${parsed?.method || 'none'} type=${parsed?.type || 'none'} sessionId=${parsed?.sessionId?.substring(0,8) || 'none'}`);

        if (parsed?.type === 'tabgroup-debug') {
            console.log(`[TABGROUP DEBUG] ${JSON.stringify(parsed)}`);
        }

        // 记录所有 PLUGIN -> CLIENT 消息到日志文件
        logCDP('PLUGIN -> CLIENT', data.toString().substring(0, CONFIG.LOG_MESSAGE_PREVIEW_LENGTH), parsed?.sessionId, ws.pluginType);

        // 处理 type: 'event' 消息（来自 background.js 的 screencast 等事件）
        if (parsed && parsed.type === 'event' && parsed.method) {
            if (parsed.method.startsWith('CDPTunnel.')) {
                console.log(`[EXT DEBUG] ${parsed.method}: ${JSON.stringify(parsed.params)}`);
            }
            const targetEvents = ['Target.targetCreated', 'Target.attachedToTarget', 'Target.targetDestroyed', 'Target.targetInfoChanged'];
            if (targetEvents.includes(parsed.method)) {
                const ns = getNamespace(ws);
                const cdpMsg = {
                    method: parsed.method,
                    params: parsed.params
                };
                if (parsed.sessionId) {
                    cdpMsg.params.sessionId = parsed.sessionId;
                }

                if (parsed.method === 'Target.targetCreated') {
                    const targetId = parsed.params?.targetInfo?.targetId;
                    const openerId = parsed.params?.targetInfo?.openerId;
                    if (openerId && targetId) {
                        const openerClientId = ns.targetIdToClientId.get(openerId);
                        if (openerClientId) {
                            ns.targetIdToClientId.set(targetId, openerClientId);
                            console.log(`[TARGET CREATED with opener] targetId=${targetId?.substring(0,8) || 'none'} openerId=${openerId?.substring(0,8) || 'none'} -> clientId=${openerClientId}`);
                        }
                    }
                }

                rewriteBrowserContextId(cdpMsg, ws);
                const cdpData = JSON.stringify(cdpMsg);

                const targetId = parsed.params?.targetInfo?.targetId;
                const eventClientId = targetId ? ns.targetIdToClientId.get(targetId) : null;

                if (eventClientId) {
                    const clientWs = clientById.get(eventClientId);
                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(cdpData);
                        console.log(`[TARGET EVENT ROUTED] ${parsed.method} targetId=${targetId?.substring(0,8)} -> clientId=${eventClientId}`);
                    }
                } else if (targetId && (parsed.method === 'Target.targetCreated' || parsed.method === 'Target.attachedToTarget')) {
                    const pendingMap = parsed.method === 'Target.targetCreated' ? ns.pendingTargetCreatedEvents : ns.pendingAttachedEvents;
                    
                    // Check if there's a pending Target.createTarget from any client.
                    // If so, cache this event — createTarget response will deliver it to the right client.
                    // If not, broadcast to discovering clients (for emitAutoAttachForExistingTargets etc.)
                    const hasPendingCreateTarget = Array.from(globalRequestIdMap.values()).some(m => m.isCreateTarget);
                    
                    if (hasPendingCreateTarget) {
                        pendingMap.set(targetId, { parsed: JSON.parse(JSON.stringify(parsed)), cdpData });
                        console.log(`[TARGET EVENT PENDING] ${parsed.method} targetId=${targetId?.substring(0,8) || 'none'} (cached, waiting for createTarget response)`);
                    } else {
                        let takeoverRouted = false;
                        ns.discoveringClientIds.forEach((timestamp, discClientId) => {
                            if (takeoverRouted) return;
                            const discWs = clientById.get(discClientId);
                            if (discWs && discWs.mode === 'takeover' && discWs.readyState === WebSocket.OPEN) {
                                discWs.send(cdpData);
                                takeoverRouted = true;
                                console.log(`[TAKEOVER EVENT ROUTED] ${parsed.method} targetId=${targetId?.substring(0,8)} -> clientId=${discClientId}`);
                                if (parsed.params?.sessionId) {
                                    ns.sessionToClientId.set(parsed.params.sessionId, discClientId);
                                }
                                ns.targetIdToClientId.set(targetId, discClientId);
                            }
                        });
                        if (!takeoverRouted) {
                            console.log(`[TARGET EVENT DROPPED] ${parsed.method} targetId=${targetId?.substring(0,8) || 'none'} (no owner, dropped for isolation)`);
                        }
                    }
                } else {
                    console.log(`[TARGET EVENT DROPPED] ${parsed.method} targetId=${targetId?.substring(0,8) || 'none'} (no owner, dropped for isolation)`);
                }
            }
            
            if (parsed.method === 'Target.attachedToTarget') {
                const ns = getNamespace(ws);
                const targetId = parsed.params?.targetInfo?.targetId;
                const sessionId = parsed.params?.sessionId;
                
                if (targetId && sessionId) {
                    const clientId = ns.targetIdToClientId.get(targetId) || ws.pairedClientId;
                    if (clientId) {
                        ns.sessionToClientId.set(sessionId, clientId);
                        console.log(`[SESSION MAPPED] sessionId=${sessionId?.substring(0,8) || 'none'} -> clientId=${clientId?.substring(0,8) || 'none'}`);
                    } else {
                        // 以前这里存 targetId 作为 value，导致 cleanupClient 按 clientId 匹配时清不掉（泄漏）
                        // 改为：暂存到 pendingSessionToClientId，等 targetId 归属绑定时再补绑
                        if (!ns.pendingSessionToClientId) ns.pendingSessionToClientId = new Map();
                        ns.pendingSessionToClientId.set(sessionId, targetId);
                        console.log(`[SESSION MAPPED] sessionId=${sessionId?.substring(0,8) || 'none'} -> targetId=${targetId?.substring(0,8) || 'none'} (pending, no clientId yet)`);
                    }
                }
            }
            
            if (!targetEvents.includes(parsed.method)) {
                const cdpMsg = {
                    method: parsed.method,
                    params: parsed.params
                };
                if (parsed.sessionId) {
                    cdpMsg.sessionId = parsed.sessionId;
                }
                const cdpData = JSON.stringify(cdpMsg);
                
                if (ws.pairedClientId) {
                    const clientWs = clientById.get(ws.pairedClientId);
                    if (safeSend(clientWs, cdpData, 'client')) {
                        logCDP('DEBUG', `Sent converted event to client: ${parsed.method}`, parsed?.sessionId);
                        return;
                    }
                }
                broadcastToClients(cdpData, ws);
            }
            return;
        }

        if (parsed && parsed.id === undefined && !parsed.method) {
            logCDP('DEBUG', `BLOCKED message (no id, no method): ${JSON.stringify(parsed).substring(0, 100)}`, null);
            return;
        }

        // 路由消息到正确的客户端
        // 优先级：请求ID路由 > Target.attachedToTarget事件 > sessionId路由 > 广播到所有客户端
        
        // 1. 请求 ID 路由：响应对应特定客户端的请求（优先级最高）
        // 响应消息有 id，可能也有 sessionId，但应该用 id 路由
        if (parsed && parsed.id !== undefined) {
            const globalId = parsed.id;
            const mapping = globalRequestIdMap.get(globalId);
            const ns = getNamespace(ws);
            console.log(`[RESPONSE DEBUG] globalId=${globalId} hasMapping=${!!mapping} sessionId=${parsed.sessionId?.substring(0,8) || 'none'} method=${parsed.method || 'response'}`);
            if (mapping) {
                const clientWs = clientById.get(mapping.clientId);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    if (mapping.isCreateBrowserContext && parsed.result?.browserContextId) {
                        const browserContextId = parsed.result.browserContextId;
                        ns.browserContextToClientId.set(browserContextId, mapping.clientId);
                        ns.clientIdToBrowserContext.set(mapping.clientId, browserContextId);
                        console.log(`[BROWSER CONTEXT MAPPED] browserContextId=${browserContextId} -> clientId=${mapping.clientId}`);
                    }
                    
                    if (parsed.result?.sessionId && mapping.method === 'Target.attachToTarget') {
                        ns.sessionToClientId.set(parsed.result.sessionId, mapping.clientId);
                        console.log(`[SESSION MAPPED from attach response] sessionId=${parsed.result.sessionId?.substring(0,8)} -> clientId=${mapping.clientId?.substring(0,8)}`);
                        if (mapping.attachTargetId && !ns.targetIdToClientId.has(mapping.attachTargetId)) {
                            ns.targetIdToClientId.set(mapping.attachTargetId, mapping.clientId);
                            console.log(`[TARGET MAPPED from attach] targetId=${mapping.attachTargetId?.substring(0,8)} -> clientId=${mapping.clientId}`);
                        }
                    }
                    
                    if (mapping.isCreateTarget && parsed.result?.targetId) {
                        const targetId = parsed.result.targetId;
                        ns.targetIdToClientId.set(targetId, mapping.clientId);
                        console.log(`[TARGET MAPPED] targetId=${targetId} -> clientId=${mapping.clientId} mapSize=${ns.targetIdToClientId.size}`);

                        // 补绑 pending 的 session（之前 targetId 归属未定时暂存的）
                        if (ns.pendingSessionToClientId && ns.pendingSessionToClientId.size > 0) {
                            const pendingSessionId = null;
                            for (const [pSid, pTid] of ns.pendingSessionToClientId.entries()) {
                                if (pTid === targetId) {
                                    ns.sessionToClientId.set(pSid, mapping.clientId);
                                    ns.pendingSessionToClientId.delete(pSid);
                                    console.log(`[SESSION MAPPED from pending] sessionId=${pSid?.substring(0,8)} -> clientId=${mapping.clientId?.substring(0,8)} (targetId=${targetId?.substring(0,8)})`);
                                }
                            }
                        }

                        const cachedCreated = ns.pendingTargetCreatedEvents.get(targetId);
                        if (cachedCreated) {
                            clientWs.send(cachedCreated.cdpData);
                            console.log(`[TARGET CREATED EVENT] Sent cached Target.targetCreated to client: ${mapping.clientId}`);
                            ns.pendingTargetCreatedEvents.delete(targetId);
                        }
                        
                        const cachedEvent = ns.pendingAttachedEvents.get(targetId);
                        if (cachedEvent) {
                            if (cachedEvent.parsed.sessionId) {
                                ns.sessionToClientId.set(cachedEvent.parsed.sessionId, mapping.clientId);
                            }
                            console.log(`[SESSION MAPPED from cached] sessionId=${cachedEvent.parsed.sessionId?.substring(0,8) || 'none'} -> clientId=${mapping.clientId} (targetId=${targetId})`);
                            ns.pendingAttachedEvents.delete(targetId);
                            
                            const cdpMsg = {
                                method: cachedEvent.parsed.method,
                                params: cachedEvent.parsed.params
                            };
                            const msgStr = JSON.stringify(cdpMsg);
                            console.log(`[ATTACHED EVENT] Full message: ${msgStr}`);
                            clientWs.send(msgStr);
                            console.log(`[ATTACHED EVENT] Sent cached event to client: ${mapping.clientId}`);
                        }
                        const newTargetInfo = cachedCreated?.parsed?.params?.targetInfo
                            || cachedEvent?.parsed?.params?.targetInfo;
                        if (newTargetInfo) {
                            const exists = ns.cachedTargets.some(t => t.targetId === targetId);
                            if (!exists) {
                                ns.cachedTargets.push(newTargetInfo);
                            }
                        } else {
                            invalidateTargetsCache(ws);
                        }
                    }
                    if (mapping.isGetTargets && parsed.result && parsed.result.targetInfos) {
                        const clientId = mapping.clientId;
                        if (mapping.isTakeover) {
                            console.log(`[GET TARGETS TAKEOVER] client=${clientId} returning unfiltered targets (${parsed.result.targetInfos.length})`);
                        } else {
                            parsed.result.targetInfos = parsed.result.targetInfos.filter(t => {
                                if (t.type !== 'page') return true;
                                const ownerClient = ns.targetIdToClientId.get(t.targetId);
                                return ownerClient === clientId;
                            });
                            console.log(`[GET TARGETS FILTERED] client=${clientId} returned ${parsed.result.targetInfos.filter(t => t.type === 'page').length} page targets`);
                        }
                    }
                    if (parsed.result && parsed.result.success !== undefined && mapping.method === 'Target.closeTarget') {
                        if (mapping.closeTargetId) {
                            ns.targetIdToClientId.delete(mapping.closeTargetId);
                            console.log(`[CLOSE TARGET CLEANUP] removed targetId=${mapping.closeTargetId?.substring(0,8)} from mapping`);
                        }
                        invalidateTargetsCache(ws);
                    }
                    
                    if (mapping.isAutoDefaultPage) {
                        console.log(`[AUTO DEFAULT PAGE] createTarget response received for client=${mapping.clientId}, targetId=${parsed.result?.targetId?.substring(0,8) || 'none'} — skipping response send to client`);
                        
                        if (mapping.pendingSetAutoAttach) {
                            const pending = mapping.pendingSetAutoAttach;
                            const pendingParsed = pending.parsed;
                            const pendingClientId = pending.clientId;
                            
                            console.log(`[AUTO DEFAULT PAGE] Now forwarding pending setAutoAttach for client=${pendingClientId}`);
                            
                            if (ws.readyState === WebSocket.OPEN) {
                                const forwardMsg = { ...pendingParsed, __clientId: pendingClientId };
                                ws.send(JSON.stringify(forwardMsg));
                                console.log(`[SEND TO PLUGIN] Forwarding setAutoAttach for client=${pendingClientId}`);
                            }
                        }
                    } else {
                        const originalId = mapping.originalId;
                        parsed.id = originalId;
                        if (mapping.sessionId && !parsed.sessionId) {
                            parsed.sessionId = mapping.sessionId;
                        }
                        const responseStr = JSON.stringify(parsed);
                        console.log(`[SEND TO CLIENT] ${responseStr.substring(0, 300)}`);
                        clientWs.send(responseStr);
                        console.log(`[ROUTE] Response global=${globalId} -> original=${originalId} -> client=${mapping.clientId} sessionId=${parsed.sessionId?.substring(0,8) || 'none'}`);
                    }
                }
                globalRequestIdMap.delete(globalId);
            } else {
                console.log(`[WARN] No mapping for global requestId: ${globalId}`);
            }
            return;
        }
        
        // 2. sessionId 路由：消息属于特定 session（事件，没有 id）
        if (parsed && parsed.sessionId) {
            const ns = getNamespace(ws);
            const targetClientId = ns.sessionToClientId.get(parsed.sessionId);
            console.log(`[SESSION ROUTE] sessionId=${parsed.sessionId?.substring(0,8) || 'none'} -> clientId=${targetClientId || 'not found'}`);
            if (targetClientId) {
                const clientWs = clientById.get(targetClientId);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(data);
                    logCDP('DEBUG', `FORWARDED to client: ${targetClientId} (sessionId route)`, parsed?.sessionId);
                }
            } else {
                console.log(`[WARN] No clientId for sessionId: ${parsed.sessionId?.substring(0, 8) || 'none'}`);
            }
            return;
        }
        
        // 3. 其他事件：无 id 和 sessionId 的消息
        // 注意：Target 事件已在上方 type: 'event' 分支处理
        // 这里只处理非 Target 事件
        if (parsed && parsed.method && !parsed.sessionId) {
            const nonTargetBroadcastMethods = [
                'Inspector.detached',
                'Log.entryAdded'
            ];
            if (nonTargetBroadcastMethods.includes(parsed.method)) {
                broadcastToClients(data, null);
            }
        }
    });

    ws.on('close', (code, reason) => {
        if (shouldLog('info')) {
            console.log(`\n[PLUGIN DISCONNECTED] ${id}`);
            console.log(`  - Code: ${code}, Reason: ${reason || 'none'}`);
            console.log(`  - Total plugin connections: ${pluginConnections.size}`);
        }
        logConnectionEvent('PLUGIN_DISCONNECTED', {
            id,
            code,
            reason: reason?.toString() || 'none',
            totalPlugins: pluginConnections.size,
            totalClients: clientConnections.size
        });
        cleanupPlugin(ws, id, `close:${code}`);
    });

    ws.on('error', (error) => {
        console.error(`[PLUGIN ERROR] ${id}:`, error.message);
        
        logConnectionEvent('PLUGIN_ERROR', {
            id,
            error: error.message,
            totalPlugins: pluginConnections.size,
            totalClients: clientConnections.size
        });
        
        pluginConnections.delete(ws);
        pluginNamespaces.delete(ws);
        
        clientConnections.forEach(clientWs => {
            if (clientWs.pairedPlugin === ws) {
                // 清理 page 连接的事件监听器
                if (clientWs.pluginMessageHandler) {
                    ws.off('message', clientWs.pluginMessageHandler);
                    clientWs.pluginMessageHandler = null;
                }
                clientWs.pairedPlugin = null;
                console.log(`  - Cleared pairedPlugin for client: ${clientWs.id} due to error`);
            }
        });
        
        if (ws.pairedClientId) {
            connectionPairs.delete(ws.pairedClientId);
        }
    });

    ws.send(JSON.stringify({
        type: 'connected',
        role: 'plugin',
        id: id,
        pluginId: ws.pluginId,
        fresh: (Date.now() - SERVER_START_TIME) < 5000,
        timestamp: Date.now()
    }));
}

function autoCreateDefaultPageAndForward(clientWs, setAutoAttachParsed, originalData, clientId, originalRequestId) {
    const pluginWs = clientWs.pairedPlugin;
    if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) {
        forwardToPlugin(clientWs, originalData, clientId);
        return;
    }

    globalRequestIdCounter++;
    const createGlobalId = globalRequestIdCounter;

    globalRequestIdMap.set(createGlobalId, {
        clientId: clientId,
        originalId: -1,
        sessionId: null,
        method: 'Target.createTarget',
        isCreateTarget: true,
        isAutoDefaultPage: true,
        pendingSetAutoAttach: {
            parsed: setAutoAttachParsed,
            data: originalData,
            clientId: clientId,
            originalRequestId: originalRequestId
        }
    });

    const request = {
        id: createGlobalId,
        method: 'Target.createTarget',
        params: { url: 'about:blank' },
        __clientId: clientId
    };

    console.log(`[AUTO DEFAULT PAGE] Sending Target.createTarget for client=${clientId} globalId=${createGlobalId}, will forward setAutoAttach after`);
    pluginWs.send(JSON.stringify(request));
}

function forwardToPlugin(clientWs, data, clientId) {
    const pluginWs = clientWs.pairedPlugin;
    if (pluginWs && pluginWs.readyState === WebSocket.OPEN) {
        console.log(`[SEND TO PLUGIN] method=Target.setAutoAttach clientId=${clientId}`);
        pluginWs.send(data);
    } else {
        broadcastToPlugins(data, clientWs);
    }
}

/**
 * 处理 CDP 客户端连接 (Playwright/Puppeteer)
 */
function handleClientConnection(ws, clientInfo, customClientId = null, targetPluginId = null, mode = 'create') {
    if (mode === 'takeover') {
        for (const client of clientConnections) {
            if (client.mode === 'takeover' && client.readyState === WebSocket.OPEN) {
                console.log('[TAKEOVER] Rejected: takeover mode already has a connected client');
                ws.close(1008, 'Takeover mode already in use. Only one client allowed.');
                return;
            }
        }
    }

    clientConnections.add(ws);
    const id = customClientId || generateId('client');
    ws.mode = mode;
    if (shouldLog('info')) {
        console.log(`\n[CLIENT CONNECTED] ID: ${id}${customClientId ? ' (custom)' : ''}${targetPluginId ? ` targetPlugin=${targetPluginId}` : ''} mode=${mode}`);
        console.log(`  - Remote: ${clientInfo.ip}:${clientInfo.port}`);
        console.log(`  - Total client connections: ${clientConnections.size}`);
    }
    
    logConnectionEvent('CLIENT_CONNECTED', {
        id,
        ip: clientInfo.ip,
        port: clientInfo.port,
        totalPlugins: pluginConnections.size,
        totalClients: clientConnections.size
    });

    if (pluginConnections.size === 0) {
        if (shouldLog('warn')) {
            console.log(`  - WARNING: No plugin connections available!`);
            console.log(`  - Please ensure Chrome extension is connected.`);
        }
        logConnectionEvent('CLIENT_NO_PLUGIN', { clientId: id });
        
        if (autoRestartEnabled) {
            const wasConnectedBefore = fs.existsSync(PLUGIN_EVER_CONNECTED_FILE);
            if (wasConnectedBefore) {
                console.log('[AUTO-RESTART] Plugin disconnected, client connecting. Attempting to restart Chrome...');
                tryAutoRestartChrome();
            } else {
                console.log('[AUTO-RESTART] No previous plugin connection found. New user? Run "cdp-tunnel extension" to install.');
            }
        }
    } else {
        let pluginWs;
        if (targetPluginId) {
            pluginWs = [...pluginConnections].find(p => p.pluginId === targetPluginId);
            if (!pluginWs) {
                if (shouldLog('warn')) {
                    console.log(`  - WARNING: Plugin ${targetPluginId} not found!`);
                }
                ws.close(4004, `Plugin ${targetPluginId} not found`);
                return;
            }
        } else {
            pluginWs = pluginConnections.values().next().value;
        }
        if (pluginWs) {
            connectionPairs.set(id, pluginWs);
            ws.pairedPlugin = pluginWs;
            ws.targetPluginId = pluginWs.pluginId;
            clientIdToPlugin.set(id, pluginWs);
            
            if (shouldLog('info')) {
                console.log(`  - Paired with plugin: ${pluginWs.id} (pluginId=${pluginWs.pluginId})`);
            }
            
            logConnectionEvent('CLIENT_PAIRED', { clientId: id, pluginId: pluginWs.id });
            
            pluginWs.send(JSON.stringify({
                type: 'client-connected',
                clientId: id
            }));
            
            broadcastClientList();
        }
    }

    ws.id = id;
    ws.isAlive = true;
    ws.cdpTrace = [];
    ws.lastActivityTime = Date.now();
    ws.connectedAt = Date.now();
    clientById.set(id, ws);

    // 心跳检测
    ws.on('pong', () => {
        ws.isAlive = true;
        logConnectionEvent('HEARTBEAT_PONG', { type: 'client', id: ws.id });
    });

    // 消息转发: Client -> Plugin
    ws.on('message', (data) => {
        ws.lastActivityTime = Date.now();
        
        const messageSize = data.length;
        let messagePreview;
        let parsed;
        try {
            parsed = JSON.parse(data);
            messagePreview = parsed.method || parsed.id || 'response';
        } catch {
            parsed = null;
            messagePreview = `binary (${messageSize} bytes)`;
        }

        if (shouldLog('debug')) {
            console.log(`[CLIENT -> PLUGIN] ${id}: ${messagePreview}`);
        }
        
        // 记录到日志文件
        logCDP('CLIENT -> PLUGIN', data.toString().substring(0, CONFIG.LOG_MESSAGE_PREVIEW_LENGTH), parsed?.sessionId);

        // 为每个请求分配全局唯一 ID，避免多客户端 ID 冲突
        let modifiedData = data;
        let originalId = null;
        let globalId = null;
        if (parsed && parsed.id !== undefined) {
            originalId = parsed.id;
            globalRequestIdCounter++;
            globalId = globalRequestIdCounter;
            
            // 保存映射：全局ID -> {clientId, originalId, sessionId}
            // 如果请求有 sessionId，也保存它，用于响应路由
            globalRequestIdMap.set(globalId, { 
                clientId: id, 
                originalId: originalId,
                sessionId: parsed.sessionId,
                method: parsed.method
            });
            
            // 修改请求ID为全局ID
            parsed.id = globalId;
            modifiedData = JSON.stringify(parsed);
            
            console.log(`[REQUEST ID MAPPED] client=${id} original=${originalId} -> global=${globalId} sessionId=${parsed.sessionId?.substring(0,8) || 'none'}`);
        }

        // 记录 Target.createTarget 请求，用于后续建立 targetId -> clientId 映射
        // 注意：此时 parsed.id 已经是 globalId，originalId 已经保存在 mapping 中
        if (parsed && parsed.method === 'Target.createTarget' && parsed.id !== undefined) {
            // 获取当前请求的映射（刚刚创建的）
            const currentMapping = globalRequestIdMap.get(parsed.id);
            if (currentMapping) {
                // 标记为 createTarget 请求
                currentMapping.isCreateTarget = true;
            }
            console.log(`[PENDING CREATE TARGET] Request id=${parsed.id} from client=${id}`);
        }
        if (parsed && parsed.id !== undefined) {
            if (parsed.method === 'Target.closeTarget') {
                const pluginWs = ws.pairedPlugin;
                const ns = pluginWs ? getNamespace(pluginWs) : null;
                const targetId = parsed.params?.targetId;
                const ownerClient = (ns && targetId) ? ns.targetIdToClientId.get(targetId) : null;
                if (ownerClient && ownerClient !== id) {
                    console.log(`[BLOCKED] ${parsed.method} targetId=${targetId?.substring(0,8)} owner=${ownerClient?.substring(0,8)} requester=${id?.substring(0,8)} — not owner`);
                    const errMsg = JSON.stringify({
                        id: originalId,
                        error: { code: -32000, message: 'Target is owned by another client' }
                    });
                    safeSend(ws, errMsg, 'client');
                    return;
                }
                const currentMapping = globalRequestIdMap.get(parsed.id);
                if (currentMapping) {
                    currentMapping.method = 'Target.closeTarget';
                    currentMapping.closeTargetId = targetId;
                }
            } else if (parsed.method === 'Target.attachToTarget') {
                const pluginWs = ws.pairedPlugin;
                const ns = pluginWs ? getNamespace(pluginWs) : null;
                const targetId = parsed.params?.targetId;
                const ownerClient = (ns && targetId) ? ns.targetIdToClientId.get(targetId) : null;
                if (ownerClient && ownerClient !== id) {
                    console.log(`[BLOCKED] ${parsed.method} targetId=${targetId?.substring(0,8)} owner=${ownerClient?.substring(0,8)} requester=${id?.substring(0,8)} — not owner`);
                    const errMsg = JSON.stringify({
                        id: originalId,
                        error: { code: -32000, message: 'Target is owned by another client' }
                    });
                    safeSend(ws, errMsg, 'client');
                    return;
                }
                const currentMapping = globalRequestIdMap.get(parsed.id);
                if (currentMapping && targetId) {
                    currentMapping.attachTargetId = targetId;
                }
            }
        }
        
        // 记录 Target.createBrowserContext 请求，用于后续建立 browserContextId -> clientId 映射
        if (parsed && parsed.method === 'Target.createBrowserContext' && parsed.id !== undefined) {
            const currentMapping = globalRequestIdMap.get(parsed.id);
            if (currentMapping) {
                currentMapping.isCreateBrowserContext = true;
            }
            console.log(`[PENDING CREATE CONTEXT] Request id=${parsed.id} from client=${id}`);
        }
        if (parsed && parsed.method === 'Target.getTargets' && parsed.id !== undefined) {
            const currentMapping = globalRequestIdMap.get(parsed.id);
            if (currentMapping) {
                currentMapping.isGetTargets = true;
                if (ws.mode === 'takeover') {
                    currentMapping.isTakeover = true;
                }
            }
        }

                if (parsed && (parsed.method === 'Target.setDiscoverTargets' || parsed.method === 'Target.setAutoAttach')) {
            const ns = ws.pairedPlugin ? getNamespace(ws.pairedPlugin) : null;
            if (ns) {
                ns.discoveringClientIds.set(id, Date.now());
                console.log(`[DISCOVERING] client=${id} method=${parsed.method}`);
            }
        }

        if (parsed && parsed.method === 'Target.setAutoAttach' && parsed.params?.autoAttach && !ws._autoDefaultPageSent) {
            ws._autoDefaultPageSent = true;
            if (ws.mode === 'takeover') {
                const takeoverMsg = { ...parsed, __clientId: id, __mode: 'takeover' };
                if (ws.pairedPlugin && ws.pairedPlugin.readyState === WebSocket.OPEN) {
                    ws.pairedPlugin.send(JSON.stringify(takeoverMsg));
                }
            } else {
                autoCreateDefaultPageAndForward(ws, parsed, modifiedData, id, originalId);
            }
            return;
        }

        if (parsed && parsed.method === 'Browser.close') {
            console.log(`[BROWSER CLOSE] Client ${id} mode=${ws.mode} requested Browser.close`);
            if (ws.pairedPlugin) {
                if (ws.mode === 'takeover') {
                    safeSend(ws.pairedPlugin, JSON.stringify({
                        type: 'takeover-disconnect',
                        clientId: id
                    }), 'plugin');
                } else {
                    safeSend(ws.pairedPlugin, JSON.stringify({
                        type: 'browser-close',
                        clientId: id
                    }), 'plugin');
                }
            }
            safeSend(ws, JSON.stringify({ id: originalId, result: {} }), 'client');
            return;
        }

        if (parsed && parsed.method) {
            ws.cdpTrace.push(parsed.method);
            if (ws.cdpTrace.length > CONFIG.CDP_TRACE_MAX_LENGTH) {
                ws.cdpTrace = ws.cdpTrace.slice(-CONFIG.CDP_TRACE_MAX_LENGTH);
            }
            if (shouldLog('debug')) {
                console.log(`[CDP TRACE] ${id} -> ${parsed.method}`);
            }
        }

        // 发送给配对的 plugin (或广播)
        if (ws.pairedPlugin && ws.pairedPlugin.readyState === WebSocket.OPEN) {
            console.log(`[SEND TO PLUGIN] id=${parsed?.id} method=${parsed?.method} sessionId=${parsed?.sessionId?.substring(0,8) || 'none'} clientId=${id}`);
            const pluginMsg = { ...parsed, __clientId: id };
            if (ws.mode === 'takeover') {
                pluginMsg.__mode = 'takeover';
            }
            ws.pairedPlugin.send(JSON.stringify(pluginMsg));
        } else {
            broadcastToPlugins(modifiedData, ws);
        }
    });

    ws.on('close', async (code, reason) => {
        logCDP('EVENT', `CLIENT DISCONNECTED id=${id} code=${code} reason=${reason.toString() || 'none'}`);
        if (shouldLog('info')) {
            console.log(`\n[CLIENT DISCONNECTED] ${id}`);
            console.log(`  - Code: ${code}, Reason: ${reason || 'none'}`);
        }
        cleanupClient(ws, id, `close:${code}`);
    });

    ws.on('error', (error) => {
        console.error(`[CLIENT ERROR] ${id}:`, error.message);
        logConnectionEvent('CLIENT_ERROR', {
            id,
            error: error.message,
            totalPlugins: pluginConnections.size,
            totalClients: clientConnections.size
        });
        cleanupClient(ws, id, `error:${error.message}`);
    });
}

function handlePageConnection(ws, clientInfo, targetId, mode = 'create') {
    clientConnections.add(ws);
    const id = generateId('page');
    if (shouldLog('info')) {
        console.log(`\n[PAGE CONNECTED] ID: ${id}, targetId: ${targetId}, mode: ${mode}`);
        console.log(`  - Remote: ${clientInfo.ip}:${clientInfo.port}`);
        console.log(`  - Total client connections: ${clientConnections.size}`);
    }

    ws.id = id;
    ws.isAlive = true;
    ws.cdpTrace = [];
    ws.targetId = targetId;
    ws.mode = mode;
    ws.lastActivityTime = Date.now();
    clientById.set(id, ws);

    // 查找 target 归属的 plugin
    let plugin = null;
    let ownerClientId = null;
    for (const p of pluginConnections) {
        const ns = getNamespace(p);
        if (ns.targetIdToClientId.has(targetId)) {
            plugin = p;
            ownerClientId = ns.targetIdToClientId.get(targetId);
            break;
        }
    }

    // create 模式：target 必须有明确的 clientId 归属，否则拒绝 attach（防止跨 client 越权）
    if (mode !== 'takeover' && !ownerClientId) {
        console.log(`[PAGE REJECTED] targetId=${targetId?.substring(0, 8)} has no owner in create mode — possible cross-client attach attempt from ${clientInfo.ip}`);
        ws.close(1008, 'Target does not belong to any client');
        clientConnections.delete(ws);
        clientById.delete(id);
        return;
    }
    // takeover 模式：允许无归属 target（操作的是用户自己的 tab）
    if (!plugin) {
        plugin = pluginConnections.values().next().value;
    }
    if (plugin && plugin.readyState === WebSocket.OPEN) {
        ws.pairedPlugin = plugin;
        if (shouldLog('info')) {
            console.log(`  - Paired with plugin: ${plugin.id}`);
        }
    }

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    const pluginMessageHandler = (data) => {
        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }
        
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }

        if (msg.type === 'event' && msg.method) {
            const cdpMsg = {
                method: msg.method,
                params: msg.params
            };
            if (msg.sessionId) {
                cdpMsg.sessionId = msg.sessionId;
            }
            
            // 对于全局 Target 事件，需要广播给所有客户端
            const broadcastEvents = ['Target.targetCreated', 'Target.attachedToTarget', 'Target.targetDestroyed', 'Target.targetInfoChanged'];
            if (broadcastEvents.includes(msg.method)) {
                rewriteBrowserContextId(cdpMsg, ws.pairedPlugin);
                console.log(`[PLUGIN -> ALL CLIENTS] Broadcasting ${msg.method}`);
                broadcastToClients(JSON.stringify(cdpMsg), null);
            } else {
                ws.lastActivityTime = Date.now();
                ws.send(JSON.stringify(cdpMsg));
            }
            return;
        }

        if (msg.id !== undefined || msg.method) {
            const messagePreview = msg.method || msg.id || 'response';
            if (shouldLog('debug')) {
                console.log(`[PLUGIN -> PAGE] ${id}: ${messagePreview}`);
            }
            ws.lastActivityTime = Date.now();
            ws.send(data.toString());
        }
    };

    ws.pluginMessageHandler = pluginMessageHandler;
    
    if (ws.pairedPlugin) {
        ws.pairedPlugin.on('message', pluginMessageHandler);
    }

    ws.on('message', (data) => {
        ws.lastActivityTime = Date.now();
        
        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }

        const messagePreview = parsed.method || parsed.id || 'response';
        if (shouldLog('debug')) {
            console.log(`[PAGE -> PLUGIN] ${id}: ${messagePreview}`);
        }

        if (parsed && parsed.method) {
            ws.cdpTrace.push(parsed.method);
            if (ws.cdpTrace.length > CONFIG.CDP_TRACE_MAX_LENGTH) {
                ws.cdpTrace = ws.cdpTrace.slice(-CONFIG.CDP_TRACE_MAX_LENGTH);
            }
        }

        if (ws.pairedPlugin) {
            const msg = { ...parsed, tabId: targetId };
            safeSend(ws.pairedPlugin, JSON.stringify(msg), 'plugin');
        }
    });

    ws.on('close', (code, reason) => {
        clientConnections.delete(ws);
        clientById.delete(id);
        if (shouldLog('info')) {
            console.log(`\n[PAGE DISCONNECTED] ${id}`);
            console.log(`  - Code: ${code}, Reason: ${reason || 'none'}`);
            console.log(`  - Total client connections: ${clientConnections.size}`);
        }

        if (ws.pairedPlugin && ws.pluginMessageHandler) {
            ws.pairedPlugin.off('message', ws.pluginMessageHandler);
            if (ws.pairedPlugin.pairedClientId === id) {
                ws.pairedPlugin.pairedClientId = null;
            }
            
            safeSend(ws.pairedPlugin, JSON.stringify({
                type: 'client-disconnected',
                clientId: id,
                sessions: []
            }), 'plugin');
            if (shouldLog('debug')) {
                console.log(`  - Notified plugin of page disconnect`);
            }
        }
        
        ws.pluginMessageHandler = null;
    });

    ws.on('error', (error) => {
        console.error(`[PAGE ERROR] ${id}:`, error.message);
        
        clientConnections.delete(ws);
        clientById.delete(id);
        
        if (ws.pairedPlugin && ws.pluginMessageHandler) {
            ws.pairedPlugin.off('message', ws.pluginMessageHandler);
            if (ws.pairedPlugin.pairedClientId === id) {
                ws.pairedPlugin.pairedClientId = null;
            }
        }
        
        ws.pluginMessageHandler = null;
    });
}

/**
 * 重写 Target 事件中的 browserContextId
 * 插件总是报告 'default'，但 Playwright 期望自己创建的 context ID
 * 通过 openerId 找到对应的 clientId，再找到该 client 的 browserContextId
 */
function rewriteBrowserContextId(cdpMsg, pluginWs) {
    const targetInfo = cdpMsg.params?.targetInfo;
    if (!targetInfo || targetInfo.browserContextId !== 'default') {
        return cdpMsg;
    }

    const ns = pluginWs ? getNamespace(pluginWs) : null;
    let clientId = null;

    if (targetInfo.openerId && ns) {
        clientId = ns.targetIdToClientId.get(targetInfo.openerId);
    }
    if (!clientId && targetInfo.targetId && ns) {
        clientId = ns.targetIdToClientId.get(targetInfo.targetId);
    }

    if (clientId && ns) {
        const contextId = ns.clientIdToBrowserContext.get(clientId);
        if (contextId) {
            console.log(`[CONTEXT REWRITE] targetId=${targetInfo.targetId?.substring(0,8) || 'none'} browserContextId: 'default' -> '${contextId}' (via openerId=${targetInfo.openerId?.substring(0,8) || 'none'}, clientId=${clientId})`);
            targetInfo.browserContextId = contextId;
        }
    }

    return cdpMsg;
}

/**
 * 广播消息给所有客户端
 */
function broadcastToClients(data, excludeWs = null) {
    let sent = 0;
    logCDP('BROADCAST', `Starting broadcast to ${clientConnections.size} clients, data preview: ${data.substring(0, 200)}`);
    clientConnections.forEach((client) => {
        logCDP('BROADCAST', `Checking client ${client.id}, state=${client.readyState}, excluded=${client === excludeWs}, hasOwnHandler=${!!client.pluginMessageHandler}`);
        if (client !== excludeWs && !client.pluginMessageHandler && safeSend(client, data, 'client')) {
            sent++;
            logCDP('BROADCAST', `Sent to client ${client.id}`);
        }
    });
    logCDP('BROADCAST', `Finished: sent to ${sent} clients`);
    return sent;
}

function broadcastToPlugins(data, excludeWs = null) {
    let sent = 0;
    pluginConnections.forEach((plugin) => {
        if (plugin !== excludeWs && safeSend(plugin, data, 'plugin')) {
            sent++;
        }
    });
    return sent;
}

function broadcastClientList() {
    const clients = [];
    clientConnections.forEach((client) => {
        clients.push({
            id: client.id,
            connectedAt: client.connectedAt,
            lastActivity: client.lastActivityTime
        });
    });
    
    broadcastToPlugins(JSON.stringify({
        type: 'client-list',
        clients: clients
    }));
}

/**
 * 生成唯一 ID
 */
function generateId(prefix = 'conn') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

const BUFFER_THRESHOLD = 1024 * 1024;
const MAX_QUEUE_SIZE = 100;
const messageQueues = new Map();

function safeSend(ws, data, label = '') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    
    const wsId = ws.id || label;
    
    if (ws.bufferedAmount > BUFFER_THRESHOLD) {
        if (shouldLog('warn')) {
            console.warn(`[BACKPRESSURE] ${wsId} buffer full (${Math.round(ws.bufferedAmount / 1024)}KB), queuing message`);
        }
        
        if (!messageQueues.has(wsId)) {
            messageQueues.set(wsId, []);
        }
        const queue = messageQueues.get(wsId);
        if (queue.length < MAX_QUEUE_SIZE) {
            queue.push(data);
            if (shouldLog('debug')) {
                console.log(`[BACKPRESSURE] ${wsId} queue size: ${queue.length}`);
            }
        } else {
            if (shouldLog('warn')) {
                console.warn(`[BACKPRESSURE] ${wsId} queue full, dropping oldest message`);
            }
            queue.shift();
            queue.push(data);
        }
        return false;
    }
    
    if (ws.lastActivityTime !== undefined) {
        ws.lastActivityTime = Date.now();
    }
    
    try {
        ws.send(data);
        return true;
    } catch (e) {
        console.error(`[SEND_ERROR] ${wsId}:`, e.message);
        return false;
    }
}

setInterval(() => {
    messageQueues.forEach((queue, wsId) => {
        let ws = null;
        for (const conn of pluginConnections) {
            if (conn.id === wsId) { ws = conn; break; }
        }
        if (!ws) {
            for (const conn of clientConnections) {
                if (conn.id === wsId) { ws = conn; break; }
            }
        }
        
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            messageQueues.delete(wsId);
            if (shouldLog('debug')) {
                console.log(`[QUEUE] ${wsId} cleaned up (connection closed)`);
            }
            return;
        }
        
        if (ws.bufferedAmount < BUFFER_THRESHOLD / 2) {
            const data = queue.shift();
            if (data) {
                try {
                    ws.send(data);
                    if (shouldLog('debug')) {
                        console.log(`[QUEUE] ${wsId} sent queued message, remaining: ${queue.length}`);
                    }
                } catch (e) {
                    console.error(`[QUEUE_ERROR] ${wsId}:`, e.message);
                }
            }
        }
        
        if (queue.length === 0) {
            messageQueues.delete(wsId);
        }
    });
}, 100);

/**
 * 心跳检测 - 每 30 秒检查一次
 */
const heartbeatInterval = setInterval(() => {
    const now = new Date().toISOString();
    const nowMs = Date.now();

    pluginConnections.forEach((ws) => {
        if (!ws.isAlive) {
            ws.missedPings = (ws.missedPings || 0) + 1;
            if (ws.missedPings >= CONFIG.PLUGIN_MAX_MISSED_PINGS) {
                if (shouldLog('warn')) {
                    console.log(`[${now}] Plugin ${ws.id} missed ${ws.missedPings} pings, terminating...`);
                }
                logConnectionEvent('HEARTBEAT_TIMEOUT', { type: 'plugin', id: ws.id, missedPings: ws.missedPings });
                cleanupPlugin(ws, ws.id, 'heartbeat_timeout');
                return ws.terminate();
            }
            if (shouldLog('info')) {
                console.log(`[${now}] Plugin ${ws.id} missed ping ${ws.missedPings}/${CONFIG.PLUGIN_MAX_MISSED_PINGS}`);
            }
        } else {
            ws.missedPings = 0;
        }
        ws.isAlive = false;
        ws.ping();
        logConnectionEvent('HEARTBEAT_PING', { type: 'plugin', id: ws.id, bufferedAmount: ws.bufferedAmount });
    });

    clientConnections.forEach((ws) => {
        if (!ws.isAlive) {
            if (shouldLog('warn')) {
                console.log(`[${now}] Client ${ws.id} not responding, terminating...`);
            }
            logConnectionEvent('HEARTBEAT_TIMEOUT', { type: 'client', id: ws.id });
            cleanupClient(ws, ws.id, 'heartbeat_timeout');
            return ws.terminate();
        }
        
        if (ws.lastActivityTime && (nowMs - ws.lastActivityTime > CONFIG.CLIENT_IDLE_TIMEOUT)) {
            const idleSeconds = Math.round((nowMs - ws.lastActivityTime) / 1000);
            if (shouldLog('info')) {
                console.log(`[${now}] Client ${ws.id} idle for ${idleSeconds}s, closing...`);
            }
            logConnectionEvent('CLIENT_IDLE_TIMEOUT', { 
                type: 'client', 
                id: ws.id, 
                idleSeconds,
                lastActivityTime: new Date(ws.lastActivityTime).toISOString()
            });
            ws.close(1001, `Idle timeout: no activity for ${idleSeconds} seconds`);
            return;
        }
        
        ws.isAlive = false;
        ws.ping();
        logConnectionEvent('HEARTBEAT_PING', { type: 'client', id: ws.id, bufferedAmount: ws.bufferedAmount });
    });
}, CONFIG.HEARTBEAT_INTERVAL);

setInterval(() => {
    const toRemove = [];
    pluginConnections.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) {
            toRemove.push(ws);
        }
    });
    toRemove.forEach(ws => {
        cleanupPlugin(ws, ws.id, 'zombie_cleanup');
    });
    
    toRemove.length = 0;
    clientConnections.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) {
            toRemove.push(ws);
        }
    });
    toRemove.forEach(ws => {
        cleanupClient(ws, ws.id, 'zombie_cleanup');
    });
}, 60000);

/**
 * 服务器关闭处理
 */
wss.on('close', () => {
    clearInterval(heartbeatInterval);
    console.log('\n[SERVER] Server closed');
});

/**
 * 定期打印状态
 */
setInterval(() => {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    
    const validPlugins = Array.from(pluginConnections).filter(ws => ws.readyState === WebSocket.OPEN);
    const zombiePlugins = Array.from(pluginConnections).filter(ws => ws.readyState !== WebSocket.OPEN);
    const validClients = Array.from(clientConnections).filter(ws => ws.readyState === WebSocket.OPEN);
    const zombieClients = Array.from(clientConnections).filter(ws => ws.readyState !== WebSocket.OPEN);
    
    if (shouldLog('info')) {
        console.log(`\n[${now}] Status:`);
        console.log(`  - Plugin connections: ${validPlugins.length} valid / ${pluginConnections.size} total`);
        console.log(`  - Client connections: ${validClients.length} valid / ${clientConnections.size} total`);
        console.log(`  - Active pairs: ${connectionPairs.size}`);
    }
    
    if (zombiePlugins.length > 0 && shouldLog('warn')) {
        console.log(`  - Zombie plugins: ${zombiePlugins.map(ws => `${ws.id}(${ws.readyState})`).join(', ')}`);
    }
    if (zombieClients.length > 0 && shouldLog('warn')) {
        console.log(`  - Zombie clients: ${zombieClients.map(ws => `${ws.id}(${ws.readyState})`).join(', ')}`);
    }
    
    const pluginList = Array.from(pluginConnections).map(ws => ({
        id: ws.id,
        readyState: ws.readyState,
        pairedClientId: ws.pairedClientId,
        bufferedAmount: ws.bufferedAmount,
        isAlive: ws.isAlive
    }));
    
    const clientList = Array.from(clientConnections).map(ws => {
        const idleMs = ws.lastActivityTime ? nowMs - ws.lastActivityTime : 0;
        return {
            id: ws.id,
            readyState: ws.readyState,
            hasPairedPlugin: !!ws.pairedPlugin,
            bufferedAmount: ws.bufferedAmount,
            isAlive: ws.isAlive,
            idleSeconds: Math.round(idleMs / 1000)
        };
    });
    
    let totalSessions = 0;
    let totalPendingAttach = 0;
    pluginNamespaces.forEach(ns => {
        totalSessions += ns.sessionToClientId.size;
        totalPendingAttach += ns.pendingAttachRequests.size;
    });
    
    logStatus({
        timestamp: now,
        plugins: pluginConnections.size,
        validPlugins: validPlugins.length,
        clients: clientConnections.size,
        validClients: validClients.length,
        pairs: connectionPairs.size,
        pluginDetails: pluginList,
        clientDetails: clientList,
        sessions: totalSessions,
        pendingAttach: totalPendingAttach
    });
}, CONFIG.STATUS_PRINT_INTERVAL);

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n[SERVER] Shutting down (SIGINT)...');
    logCDP('SERVER', 'Shutting down (SIGINT)');
    clearInterval(heartbeatInterval);

    pluginConnections.forEach(ws => ws.close(1001, 'Server shutting down'));
    clientConnections.forEach(ws => ws.close(1001, 'Server shutting down'));

    wss.close(() => {
        console.log('[SERVER] Server closed');
        flushAllLogs();
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('[SERVER] Shutting down (SIGTERM)...');
    logCDP('SERVER', 'Shutting down (SIGTERM)');
    flushAllLogs();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err.message, err.stack);
    logCDP('FATAL', `Uncaught exception: ${err.message}\n${err.stack}`);
    flushAllLogs();
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    logCDP('FATAL', `Unhandled rejection: ${reason}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Port ${PORT} is already in use. Is another cdp-tunnel running?`);
        console.error(`  Run "cdp-tunnel stop" first, or kill the process on port ${PORT}.`);
        logCDP('FATAL', `Port ${PORT} already in use (EADDRINUSE)`);
        flushAllLogs();
        process.exit(2);
    }
    console.error('[FATAL] Server error:', err.message);
    logCDP('FATAL', `Server error: ${err.message}`);
    flushAllLogs();
    process.exit(1);
});

server.listen(PORT, '0.0.0.0');

const takeoverServer = http.createServer((req, res) => {
    req._takeoverMode = true;
    handleHttpRequest(req, res);
});
takeoverServer.on('upgrade', (req, socket, head) => {
    req._takeoverMode = true;
    const url = new URL(req.url, `http://localhost:${TAKEOVER_PORT}`);
    const path = url.pathname;
    const isPlugin = path === '/plugin';
    const isClient = path === '/client' ||
                     path.startsWith('/client/') ||
                     path.startsWith('/client-') ||
                     path.startsWith('/devtools/browser/') ||
                     path.startsWith('/devtools/page/');

    if (!isPlugin && !isClient) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});
takeoverServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[WARN] Takeover port ${TAKEOVER_PORT} is already in use. Takeover mode disabled.`);
    } else {
        console.error('[WARN] Takeover server error:', err.message);
    }
});
takeoverServer.listen(TAKEOVER_PORT, '0.0.0.0', () => {
    console.log(`[TAKEOVER] Listening on port ${TAKEOVER_PORT}`);
});

// v3.0 端口池启动
portPool = new PortPoolManager({
    getPluginConnection: () => {
        for (const ws of pluginConnections) return ws;
        return null;
    },
    getAllTargets: async (portIndex) => {
        const session = portPool.portSessions[portIndex];
        if (!session) return [];
        // 从主 proxy 的 namespace 拿所有 target，过滤出这个端口的
        const targets = [];
        for (const [, ns] of pluginNamespaces) {
            if (ns.cachedTargets) {
                for (const t of ns.cachedTargets) {
                    if (session.targetIds.has(t.targetId)) {
                        targets.push(t);
                    }
                }
            }
        }
        return targets;
    }
});
portPool.start();

