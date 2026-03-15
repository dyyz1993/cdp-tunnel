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
const { CONFIG, BROWSER_ID, shouldLog } = require('./modules/config');
const { logCDP, logEvent, clearLog, logStatus, logConnectionEvent, flushAllLogs } = require('./modules/logger');

const PORT = CONFIG.PORT;

clearLog();

const wss = new WebSocket.Server({ noServer: true });
const server = http.createServer((req, res) => handleHttpRequest(req, res));

const pluginConnections = new Set();
const clientConnections = new Set();

const connectionPairs = new Map();
const clientById = new Map();
const sessionToClientId = new Map();
const pendingAttachRequests = new Map();
const clientIdToPlugin = new Map();
const globalRequestIdMap = new Map();
const targetIdToClientId = new Map();
const pendingAttachedEvents = new Map();
const browserContextToClientId = new Map();
let globalRequestIdCounter = 0;

let cachedTargets = [];
let lastTargetsUpdate = 0;

console.log('='.repeat(60));
console.log('  WebSocket CDP Proxy Server');
console.log('='.repeat(60));
console.log(`  Server started on port ${PORT}`);
console.log(`  - Plugin path: ws://localhost:${PORT}/plugin`);
console.log(`  - Client path: ws://localhost:${PORT}/client`);
console.log(`  - CDP endpoint: http://localhost:${PORT}`);
console.log('='.repeat(60));

/**
 * 获取请求的 Host
 */
function getHost(req) {
    return req.headers.host || `localhost:${PORT}`;
}

/**
 * 生成 WebSocket 调试地址
 */
function buildWebSocketDebuggerUrl(req) {
    return `ws://${getHost(req)}/devtools/browser/${BROWSER_ID}`;
}

function buildTargetWebSocketUrl(req, targetId) {
    return `ws://${getHost(req)}/devtools/page/${targetId}`;
}

async function requestTargetsFromPlugin() {
    const now = Date.now();
    if (now - lastTargetsUpdate < CONFIG.TARGETS_CACHE_TTL && cachedTargets.length > 0) {
        return cachedTargets;
    }

    const plugin = pluginConnections.values().next().value;
    if (!plugin || plugin.readyState !== WebSocket.OPEN) {
        return cachedTargets;
    }

    return new Promise((resolve) => {
        const requestId = `targets_${Date.now()}`;
        const timeout = setTimeout(() => {
            resolve(cachedTargets);
        }, CONFIG.TARGETS_REQUEST_TIMEOUT);

        const handler = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === requestId && msg.result?.targetInfos) {
                    clearTimeout(timeout);
                    plugin.off('message', handler);
                    cachedTargets = msg.result.targetInfos;
                    lastTargetsUpdate = now;
                    resolve(cachedTargets);
                }
            } catch (e) {}
        };

        plugin.on('message', handler);
        plugin.send(JSON.stringify({ id: requestId, method: 'Target.getTargets' }));
    });
}

/**
 * 处理 HTTP 请求
 */
async function handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    if (url.pathname === '/json/version' || url.pathname === '/json/version/') {
        const payload = {
            Browser: 'CDP Bridge',
            'Protocol-Version': '1.3',
            'User-Agent': 'Chrome',
            'V8-Version': '',
            webSocketDebuggerUrl: buildWebSocketDebuggerUrl(req)
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
    }
    
    if (url.pathname === '/json' || url.pathname === '/json/' ||
        url.pathname === '/json/list' || url.pathname === '/json/list/') {
        const targets = await requestTargetsFromPlugin();
        const targetList = targets
            .filter(t => {
                if (t.type !== 'page') return false;
                const url = t.url || '';
                if (url.startsWith('chrome://') || 
                    url.startsWith('chrome-extension://') ||
                    url.startsWith('devtools://') ||
                    url.startsWith('about:blank') ||
                    url.startsWith('edge://')) {
                    return false;
                }
                return true;
            })
            .map(t => ({
                description: '',
                devtoolsFrontendUrl: '',
                id: t.targetId,
                title: t.title || '',
                type: t.type,
                url: t.url || '',
                webSocketDebuggerUrl: buildTargetWebSocketUrl(req, t.targetId)
            }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(targetList));
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
    const isPlugin = path === '/plugin';
    const isClient = path === '/client' || 
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

    const clientInfo = {
        ip: req.socket.remoteAddress,
        port: req.socket.remotePort
    };

    if (path === '/plugin') {
        handlePluginConnection(ws, clientInfo);
    } else if (path === '/client' || path.startsWith('/client-') || path.startsWith('/devtools/browser/')) {
        const customClientId = path.startsWith('/client-') ? path.replace('/client-', '') : null;
        handleClientConnection(ws, clientInfo, customClientId);
    } else if (path.startsWith('/devtools/page/')) {
        const targetId = path.replace('/devtools/page/', '');
        handlePageConnection(ws, clientInfo, targetId);
    } else {
        console.log(`[REJECTED] Unknown path: ${path} from ${clientInfo.ip}:${clientInfo.port}`);
        ws.close(1008, 'Invalid path. Use /plugin or /client');
    }
});

/**
 * 处理 Chrome 扩展连接
 */
function handlePluginConnection(ws, clientInfo) {
    const id = generateId('plugin');
    
    if (pluginConnections.size > 0) {
        const toRemove = [];
        pluginConnections.forEach(oldWs => {
            if (oldWs !== ws) {
                if (oldWs.readyState === WebSocket.OPEN) {
                    oldWs.send(JSON.stringify({ type: 'server-restart' }));
                    oldWs.close(1001, 'Server restarted');
                }
                toRemove.push(oldWs);
            }
        });
        toRemove.forEach(oldWs => {
            pluginConnections.delete(oldWs);
            if (shouldLog('info')) {
                console.log(`[PLUGIN] Removed old connection: ${oldWs.id}`);
            }
        });
    }
    
    sessionToClientId.clear();
    pendingAttachRequests.clear();
    connectionPairs.clear();
    clientConnections.forEach(clientWs => {
        clientWs.pairedPlugin = null;
    });
    
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
        
        // 处理 keepalive 消息
        if (parsed && parsed.type === 'keepalive') {
            ws.isAlive = true;
            logConnectionEvent('KEEPALIVE_RECEIVED', { type: 'plugin', id: ws.id });
            return;
        }
        
        // 记录所有 PLUGIN -> CLIENT 消息到日志文件
        logCDP('PLUGIN -> CLIENT', data.toString().substring(0, CONFIG.LOG_MESSAGE_PREVIEW_LENGTH), parsed?.sessionId, ws.pluginType);
        
        // 调试：打印所有收到的消息
        console.log(`[PLUGIN MSG] id=${parsed?.id} method=${parsed?.method || 'none'} type=${parsed?.type || 'none'} sessionId=${parsed?.sessionId?.substring(0,8) || 'none'}`);

        // 处理 type: 'event' 消息（来自 background.js 的 screencast 等事件）
        if (parsed && parsed.type === 'event' && parsed.method) {
            logCDP('DEBUG', `Converting type:event message: ${parsed.method}`, parsed?.sessionId);
            
            // 处理 Target.attachedToTarget 事件，建立 sessionId -> clientId 映射
            if (parsed.method === 'Target.attachedToTarget') {
                const targetId = parsed.params?.targetInfo?.targetId;
                const sessionId = parsed.params?.sessionId;
                
                console.log(`[ATTACHED EVENT (type:event)] targetId=${targetId} sessionId=${sessionId?.substring(0,8)}`);
                
                // 查找 targetId 对应的 clientId
                const clientId = targetIdToClientId.get(targetId);
                if (clientId && sessionId) {
                    sessionToClientId.set(sessionId, clientId);
                    console.log(`[SESSION MAPPED from event] sessionId=${sessionId.substring(0,8)} -> clientId=${clientId} (targetId=${targetId})`);
                    targetIdToClientId.delete(targetId);
                    
                    // 转换为 CDP 格式并发送给对应的客户端
                    const cdpMsg = {
                        method: parsed.method,
                        params: parsed.params
                    };
                    
                    const clientWs = clientById.get(clientId);
                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify(cdpMsg));
                        console.log(`[ATTACHED EVENT] Sent to client: ${clientId}`);
                    }
                    return;
                } else if (targetId && sessionId) {
                    // targetId 还没有映射，缓存事件等待 Target.createTarget 响应
                    pendingAttachedEvents.set(targetId, { sessionId, parsed, data });
                    console.log(`[ATTACHED EVENT] Cached for targetId=${targetId}, waiting for createTarget response`);
                    return;
                }
            }
            
            const cdpMsg = {
                method: parsed.method,
                params: parsed.params
            };
            if (parsed.sessionId) {
                cdpMsg.sessionId = parsed.sessionId;
            }
            const cdpData = JSON.stringify(cdpMsg);
            
            // 发送给配对的 client
            if (ws.pairedClientId) {
                const clientWs = clientById.get(ws.pairedClientId);
                if (safeSend(clientWs, cdpData, 'client')) {
                    logCDP('DEBUG', `Sent converted event to client: ${parsed.method}`, parsed?.sessionId);
                    return;
                }
            }
            // 广播给所有 client
            broadcastToClients(cdpData, ws);
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
            console.log(`[RESPONSE DEBUG] globalId=${globalId} hasMapping=${!!mapping} sessionId=${parsed.sessionId?.substring(0,8) || 'none'} method=${parsed.method || 'response'}`);
            if (mapping) {
                const clientWs = clientById.get(mapping.clientId);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    // 如果是 Target.createBrowserContext 响应，记录 browserContextId -> clientId 映射
                    if (mapping.isCreateBrowserContext && parsed.result?.browserContextId) {
                        const browserContextId = parsed.result.browserContextId;
                        browserContextToClientId.set(browserContextId, mapping.clientId);
                        console.log(`[BROWSER CONTEXT MAPPED] browserContextId=${browserContextId} -> clientId=${mapping.clientId}`);
                    }
                    
                    // 如果是 Target.createTarget 响应，先发送缓存的 Target.attachedToTarget 事件
                    // 然后再发送响应
                    if (mapping.isCreateTarget && parsed.result?.targetId) {
                        const targetId = parsed.result.targetId;
                        targetIdToClientId.set(targetId, mapping.clientId);
                        console.log(`[TARGET MAPPED] targetId=${targetId} -> clientId=${mapping.clientId}`);
                        
                        // 检查是否有缓存的 Target.attachedToTarget 事件
                        const cachedEvent = pendingAttachedEvents.get(targetId);
                        if (cachedEvent) {
                            sessionToClientId.set(cachedEvent.sessionId, mapping.clientId);
                            console.log(`[SESSION MAPPED from cached] sessionId=${cachedEvent.sessionId.substring(0,8)} -> clientId=${mapping.clientId} (targetId=${targetId})`);
                            pendingAttachedEvents.delete(targetId);
                            
                            // 先发送缓存的事件给客户端
                            // 注意：Target.attachedToTarget 事件必须发送给 root session（没有顶层 sessionId）
                            // sessionId 在 params 里面，不在消息顶层
                            const cdpMsg = {
                                method: cachedEvent.parsed.method,
                                params: cachedEvent.parsed.params
                            };
                            const msgStr = JSON.stringify(cdpMsg);
                            console.log(`[ATTACHED EVENT] Full message: ${msgStr}`);
                            clientWs.send(msgStr);
                            console.log(`[ATTACHED EVENT] Sent cached event to client: ${mapping.clientId}`);
                        }
                    }
                    
                    // 然后发送响应给客户端
                    const originalId = mapping.originalId;
                    parsed.id = originalId;
                    // 如果请求有 sessionId，但响应没有，添加 sessionId
                    if (mapping.sessionId && !parsed.sessionId) {
                        parsed.sessionId = mapping.sessionId;
                    }
                    const responseStr = JSON.stringify(parsed);
                    console.log(`[SEND TO CLIENT] ${responseStr.substring(0, 300)}`);
                    clientWs.send(responseStr);
                    console.log(`[ROUTE] Response global=${globalId} -> original=${originalId} -> client=${mapping.clientId} sessionId=${parsed.sessionId?.substring(0,8) || 'none'}`);
                }
                globalRequestIdMap.delete(globalId);
            } else {
                console.log(`[WARN] No mapping for global requestId: ${globalId}`);
            }
            return;
        }
        
        // 2. sessionId 路由：消息属于特定 session（事件，没有 id）
        if (parsed && parsed.sessionId) {
            const targetClientId = sessionToClientId.get(parsed.sessionId);
            console.log(`[SESSION ROUTE] sessionId=${parsed.sessionId?.substring(0,8)} -> clientId=${targetClientId || 'not found'}`);
            if (targetClientId) {
                const clientWs = clientById.get(targetClientId);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(data);
                    logCDP('DEBUG', `FORWARDED to client: ${targetClientId} (sessionId route)`, parsed?.sessionId);
                }
            } else {
                console.log(`[WARN] No clientId for sessionId: ${parsed.sessionId?.substring(0, 8)}`);
            }
            return;
        }
        
        // 3. 事件广播：无 id 和 sessionId 的消息（如 Target.targetCreated）
        // 只广播特定类型的事件，避免干扰其他客户端
        if (parsed && parsed.method) {
            // 处理 Target.attachedToTarget 事件，建立 sessionId -> clientId 映射
            if (parsed.method === 'Target.attachedToTarget') {
                const targetId = parsed.params?.targetInfo?.targetId;
                const sessionId = parsed.params?.sessionId;
                const openerId = parsed.params?.targetInfo?.openerId;
                
                // 查找 targetId 对应的 clientId
                let clientId = targetIdToClientId.get(targetId);
                
                // 如果没有直接映射，检查 openerId（window.open 打开的新 tab）
                if (!clientId && openerId) {
                    // 查找 openerId 对应的 clientId
                    // openerId 可能是某个已知的 targetId
                    clientId = targetIdToClientId.get(openerId);
                    if (clientId) {
                        console.log(`[OPENER TRACKING] targetId=${targetId?.substring(0,8)} openerId=${openerId?.substring(0,8)} -> clientId=${clientId}`);
                        // 记录新 targetId 的映射
                        targetIdToClientId.set(targetId, clientId);
                    }
                }
                
                if (clientId && sessionId) {
                    sessionToClientId.set(sessionId, clientId);
                    console.log(`[SESSION MAPPED from event] sessionId=${sessionId.substring(0,8)} -> clientId=${clientId} (targetId=${targetId?.substring(0,8)})`);
                    targetIdToClientId.delete(targetId);
                    
                    // 只发送给对应的客户端
                    const clientWs = clientById.get(clientId);
                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(data);
                    }
                    return;
                }
            }
            
            // 处理 Target.targetInfoChanged 事件
            if (parsed.method === 'Target.targetInfoChanged') {
                const targetId = parsed.params?.targetInfo?.targetId;
                const openerId = parsed.params?.targetInfo?.openerId;
                console.log(`[TARGET INFO CHANGED] targetId=${targetId?.substring(0,8)} openerId=${openerId?.substring(0, 8) || 'none'}`);
            }
            
            if (parsed.method === 'Target.targetCreated') {
                const targetId = parsed.params?.targetInfo?.targetId;
                const openerId = parsed.params?.targetInfo?.openerId;
                const browserContextId = parsed.params?.targetInfo?.browserContextId;
                const targetType = parsed.params?.targetInfo?.type;
                
                console.log(`[TARGET CREATED] targetId=${targetId?.substring(0,8)} type=${targetType} openerId=${openerId?.substring(0, 8) || 'none'} browserContextId=${browserContextId?.substring(0, 8) || 'none'}`);
                
                // 如果有 openerId，尝试找到对应的 clientId
                if (openerId && targetId) {
                    const openerClientId = targetIdToClientId.get(openerId);
                    if (openerClientId) {
                        targetIdToClientId.set(targetId, openerClientId);
                        console.log(`[TARGET CREATED with opener] targetId=${targetId?.substring(0,8)} openerId=${openerId?.substring(0,8)} -> clientId=${openerClientId}`);
                    }
                }
                
                // 如果有 browserContextId，尝试找到对应的 clientId
                // browserContextId 是通过 Target.createBrowserContext 创建的
                if (browserContextId && targetId) {
                    const contextClientId = browserContextToClientId.get(browserContextId);
                    if (contextClientId && !targetIdToClientId.has(targetId)) {
                        targetIdToClientId.set(targetId, contextClientId);
                        console.log(`[TARGET CREATED in context] targetId=${targetId?.substring(0,8)} browserContextId=${browserContextId?.substring(0,8)} -> clientId=${contextClientId}`);
                    }
                }
                
                // Service Worker 处理：Service Worker 通常属于创建它的页面所在的客户端
                // 通过 browserContextId 来判断归属
                if (targetType === 'service_worker' && browserContextId && targetId) {
                    const contextClientId = browserContextToClientId.get(browserContextId);
                    if (contextClientId) {
                        targetIdToClientId.set(targetId, contextClientId);
                        console.log(`[SERVICE WORKER] targetId=${targetId?.substring(0,8)} -> clientId=${contextClientId}`);
                    }
                }
                
                // iframe (OOPIF) 处理：跨域 iframe 可能有独立的 target
                // 通过 openerId 或 browserContextId 来判断归属
                if (targetType === 'iframe' && targetId) {
                    // 优先使用 openerId
                    if (openerId) {
                        const openerClientId = targetIdToClientId.get(openerId);
                        if (openerClientId) {
                            targetIdToClientId.set(targetId, openerClientId);
                            console.log(`[IFRAME with opener] targetId=${targetId?.substring(0,8)} openerId=${openerId?.substring(0,8)} -> clientId=${openerClientId}`);
                        }
                    } else if (browserContextId) {
                        // 否则使用 browserContextId
                        const contextClientId = browserContextToClientId.get(browserContextId);
                        if (contextClientId) {
                            targetIdToClientId.set(targetId, contextClientId);
                            console.log(`[IFRAME in context] targetId=${targetId?.substring(0,8)} browserContextId=${browserContextId?.substring(0,8)} -> clientId=${contextClientId}`);
                        }
                    }
                }
            }
            
            const broadcastMethods = [
                'Target.targetCreated',
                'Target.targetDestroyed',
                'Target.targetInfoChanged'
            ];
            if (broadcastMethods.includes(parsed.method)) {
                for (const clientWs of clientConnections) {
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(data);
                    }
                }
            }
        }
    });

    // 连接关闭
    ws.on('close', (code, reason) => {
        pluginConnections.delete(ws);
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

        // 清理配对关系并通知所有受影响的 Client
        const affectedClients = [];
        clientConnections.forEach(clientWs => {
            if (clientWs.pairedPlugin === ws) {
                // 清理 page 连接的事件监听器
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
                if (shouldLog('debug')) {
                    console.log(`  - Cleared pairedPlugin for client: ${clientWs.id}`);
                }
            }
        });
        
        if (affectedClients.length > 0) {
            logConnectionEvent('PLUGIN_DISCONNECT_AFFECTED_CLIENTS', { pluginId: id, affectedClients });
        }
        
        if (ws.pairedClientId) {
            connectionPairs.delete(ws.pairedClientId);
        }
    });

    // 错误处理
    ws.on('error', (error) => {
        console.error(`[PLUGIN ERROR] ${id}:`, error.message);
        
        logConnectionEvent('PLUGIN_ERROR', {
            id,
            error: error.message,
            totalPlugins: pluginConnections.size,
            totalClients: clientConnections.size
        });
        
        pluginConnections.delete(ws);
        
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
        fresh: true,
        timestamp: Date.now()
    }));
}

/**
 * 处理 CDP 客户端连接 (Playwright/Puppeteer)
 */
function handleClientConnection(ws, clientInfo, customClientId = null) {
    clientConnections.add(ws);
    const id = customClientId || generateId('client');
    if (shouldLog('info')) {
        console.log(`\n[CLIENT CONNECTED] ID: ${id}${customClientId ? ' (custom)' : ''}`);
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

    // 检查是否有可用的 plugin 连接
    if (pluginConnections.size === 0) {
        if (shouldLog('warn')) {
            console.log(`  - WARNING: No plugin connections available!`);
            console.log(`  - Please ensure Chrome extension is connected.`);
        }
        logConnectionEvent('CLIENT_NO_PLUGIN', { clientId: id });
    } else {
        // 多客户端模式: 所有客户端共享同一个 plugin
        // 每个 clientId 对应不同的 tab
        const pluginWs = pluginConnections.values().next().value;
        if (pluginWs) {
            connectionPairs.set(id, pluginWs);
            ws.pairedPlugin = pluginWs;
            clientIdToPlugin.set(id, pluginWs);
            
            if (shouldLog('info')) {
                console.log(`  - Paired with plugin: ${pluginWs.id} (shared mode)`);
            }
            
            logConnectionEvent('CLIENT_PAIRED', { clientId: id, pluginId: pluginWs.id });
            
            // 通知 Plugin 新客户端已连接
            pluginWs.send(JSON.stringify({
                type: 'client-connected',
                clientId: id
            }));
            
            // 发送当前所有客户端列表
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
        if (parsed && parsed.id !== undefined) {
            const originalId = parsed.id;
            globalRequestIdCounter++;
            const globalId = globalRequestIdCounter;
            
            // 保存映射：全局ID -> {clientId, originalId, sessionId}
            // 如果请求有 sessionId，也保存它，用于响应路由
            globalRequestIdMap.set(globalId, { 
                clientId: id, 
                originalId: originalId,
                sessionId: parsed.sessionId  // 保存请求的 sessionId
            });
            
            // 修改请求ID为全局ID
            parsed.id = globalId;
            modifiedData = JSON.stringify(parsed);
            
            console.log(`[REQUEST ID MAPPED] client=${id} original=${originalId} -> global=${globalId} sessionId=${parsed.sessionId?.substring(0,8) || 'none'}`);
        }

        // 记录 Target.attachToTarget 请求，用于后续建立 session -> clientId 映射
        if (parsed && parsed.method === 'Target.attachToTarget' && parsed.id !== undefined) {
            pendingAttachRequests.set(parsed.id, id);
            console.log(`[PENDING ATTACH] Request id=${parsed.id} from client=${id}, pending size=${pendingAttachRequests.size}`);
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
        
        // 记录 Target.createBrowserContext 请求，用于后续建立 browserContextId -> clientId 映射
        if (parsed && parsed.method === 'Target.createBrowserContext' && parsed.id !== undefined) {
            const currentMapping = globalRequestIdMap.get(parsed.id);
            if (currentMapping) {
                currentMapping.isCreateBrowserContext = true;
            }
            console.log(`[PENDING CREATE CONTEXT] Request id=${parsed.id} from client=${id}`);
        }

        // 拦截 Browser.close - 清理会话状态
        if (parsed && parsed.method === 'Browser.close') {
            if (shouldLog('info')) {
                console.log(`\n[BROWSER CLOSE] Client ${id} requested Browser.close`);
            }
            
            // 清理该客户端的所有 session 映射
            const sessionsToClean = [];
            for (const [sessionId, clientId] of sessionToClientId.entries()) {
                if (clientId === id) {
                    sessionsToClean.push(sessionId);
                    sessionToClientId.delete(sessionId);
                }
            }
            if (shouldLog('info')) {
                console.log(`  - Cleaned ${sessionsToClean.length} sessions`);
            }
            
            // 通知扩展清理状态
            if (ws.pairedPlugin && ws.pairedPlugin.readyState === WebSocket.OPEN) {
                ws.pairedPlugin.send(JSON.stringify({
                    type: 'browser-close',
                    clientId: id,
                    sessions: sessionsToClean
                }));
            }
            
            // 返回 mock 响应（包含 sessionId）
            const response = { id: parsed.id, result: {} };
            if (parsed.sessionId) {
                response.sessionId = parsed.sessionId;
            }
            ws.send(JSON.stringify(response));
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
            console.log(`[SEND TO PLUGIN] id=${parsed?.id} method=${parsed?.method} sessionId=${parsed?.sessionId?.substring(0,8) || 'none'}`);
            ws.pairedPlugin.send(modifiedData);
        } else {
            broadcastToPlugins(modifiedData, ws);
        }
    });

    // 连接关闭
    ws.on('close', async (code, reason) => {
        // 记录断开事件到日志文件
        logCDP('EVENT', `CLIENT DISCONNECTED id=${id} code=${code} reason=${reason.toString() || 'none'}`);
        
        // 收集该 client 的所有 session
        const sessionsToClean = [];
        for (const [sessionId, clientId] of sessionToClientId.entries()) {
            if (clientId === id) {
                sessionsToClean.push(sessionId);
                sessionToClientId.delete(sessionId);
            }
        }
        
        clientConnections.delete(ws);
        clientById.delete(id);
        if (shouldLog('info')) {
            console.log(`\n[CLIENT DISCONNECTED] ${id}`);
            console.log(`  - Code: ${code}, Reason: ${reason || 'none'}`);
            console.log(`  - Sessions to clean: ${sessionsToClean.length}`);
            console.log(`  - Total client connections: ${clientConnections.size}`);
        }
        
        logConnectionEvent('CLIENT_DISCONNECTED', {
            id,
            code,
            reason: reason?.toString() || 'none',
            sessionsCleaned: sessionsToClean.length,
            totalPlugins: pluginConnections.size,
            totalClients: clientConnections.size
        });
        
        if (ws.cdpTrace && ws.cdpTrace.length && shouldLog('debug')) {
            const unique = [...new Set(ws.cdpTrace)];
            console.log(`[CDP TRACE] ${id} methods (${ws.cdpTrace.length}): ${unique.join(', ')}`);
        }

        // 向 plugin 发送清理命令
        if (ws.pairedPlugin) {
            safeSend(ws.pairedPlugin, JSON.stringify({
                type: 'client-disconnected',
                clientId: id,
                sessions: sessionsToClean
            }), 'plugin');
            if (shouldLog('debug')) {
                console.log(`  - Notified plugin of client disconnect`);
            }
        }

        // 广播更新后的客户端列表
        broadcastClientList();

        // 清理配对关系
        if (ws.pairedPlugin) {
            ws.pairedPlugin.pairedClientId = null;
        }
        connectionPairs.delete(id);
    });

    // 错误处理
    ws.on('error', (error) => {
        console.error(`[CLIENT ERROR] ${id}:`, error.message);
        
        logConnectionEvent('CLIENT_ERROR', {
            id,
            error: error.message,
            totalPlugins: pluginConnections.size,
            totalClients: clientConnections.size
        });
        
        clientConnections.delete(ws);
        clientById.delete(id);
        
        if (ws.pairedPlugin) {
            ws.pairedPlugin.pairedClientId = null;
        }
        connectionPairs.delete(id);
    });
}

function handlePageConnection(ws, clientInfo, targetId) {
    clientConnections.add(ws);
    const id = generateId('page');
    if (shouldLog('info')) {
        console.log(`\n[PAGE CONNECTED] ID: ${id}, targetId: ${targetId}`);
        console.log(`  - Remote: ${clientInfo.ip}:${clientInfo.port}`);
        console.log(`  - Total client connections: ${clientConnections.size}`);
    }

    ws.id = id;
    ws.isAlive = true;
    ws.cdpTrace = [];
    ws.targetId = targetId;
    ws.lastActivityTime = Date.now();
    clientById.set(id, ws);

    const plugin = pluginConnections.values().next().value;
    if (plugin && plugin.readyState === WebSocket.OPEN) {
        ws.pairedPlugin = plugin;
        plugin.pairedClientId = id;
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
            
            if (msg.method === 'Page.screencastFrame' && shouldLog('debug')) {
                console.log(`[PLUGIN -> PAGE] ${id}: Page.screencastFrame`);
            }
            ws.lastActivityTime = Date.now();
            ws.send(JSON.stringify(cdpMsg));
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
            ws.pairedPlugin.pairedClientId = null;
            
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
            ws.pairedPlugin.pairedClientId = null;
        }
        
        ws.pluginMessageHandler = null;
    });
}

/**
 * 广播消息给所有客户端
 */
function broadcastToClients(data, excludeWs = null) {
    let sent = 0;
    clientConnections.forEach((client) => {
        if (client !== excludeWs && safeSend(client, data, 'client')) {
            sent++;
        }
    });
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

    // 检查 plugin 连接
    pluginConnections.forEach((ws) => {
        if (!ws.isAlive) {
            if (shouldLog('warn')) {
                console.log(`[${now}] Plugin ${ws.id} not responding, terminating...`);
            }
            logConnectionEvent('HEARTBEAT_TIMEOUT', { type: 'plugin', id: ws.id });
            pluginConnections.delete(ws);
            if (ws.pairedClientId) {
                connectionPairs.delete(ws.pairedClientId);
                const clientWs = clientById.get(ws.pairedClientId);
                if (clientWs) {
                    clientWs.pairedPlugin = null;
                }
            }
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
        logConnectionEvent('HEARTBEAT_PING', { type: 'plugin', id: ws.id, bufferedAmount: ws.bufferedAmount });
    });

    // 检查 client 连接
    clientConnections.forEach((ws) => {
        if (!ws.isAlive) {
            if (shouldLog('warn')) {
                console.log(`[${now}] Client ${ws.id} not responding, terminating...`);
            }
            logConnectionEvent('HEARTBEAT_TIMEOUT', { type: 'client', id: ws.id });
            clientConnections.delete(ws);
            clientById.delete(ws.id);
            if (ws.pairedPlugin) {
                ws.pairedPlugin.pairedClientId = null;
            }
            connectionPairs.delete(ws.id);
            return ws.terminate();
        }
        
        // 检查空闲超时
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
        pluginConnections.delete(ws);
        if (shouldLog('debug')) {
            console.log(`[CLEANUP] Removed zombie plugin: ${ws.id}, state: ${ws.readyState}`);
        }
    });
    
    toRemove.length = 0;
    clientConnections.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) {
            toRemove.push(ws);
        }
    });
    toRemove.forEach(ws => {
        clientConnections.delete(ws);
        clientById.delete(ws.id);
        if (shouldLog('debug')) {
            console.log(`[CLEANUP] Removed zombie client: ${ws.id}, state: ${ws.readyState}`);
        }
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
    
    logStatus({
        timestamp: now,
        plugins: pluginConnections.size,
        validPlugins: validPlugins.length,
        clients: clientConnections.size,
        validClients: validClients.length,
        pairs: connectionPairs.size,
        pluginDetails: pluginList,
        clientDetails: clientList,
        sessions: sessionToClientId.size,
        pendingAttach: pendingAttachRequests.size
    });
}, CONFIG.STATUS_PRINT_INTERVAL);

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n[SERVER] Shutting down...');
    clearInterval(heartbeatInterval);

    // 关闭所有连接
    pluginConnections.forEach(ws => ws.close(1001, 'Server shutting down'));
    clientConnections.forEach(ws => ws.close(1001, 'Server shutting down'));

    wss.close(() => {
        console.log('[SERVER] Server closed');
        flushAllLogs();
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    flushAllLogs();
    process.exit(0);
});

server.listen(PORT, '0.0.0.0');
