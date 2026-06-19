'use strict';

/**
 * 端口池管理器（v3.0）
 *
 * 在现有 proxy 之外，额外启动一组 create 端口（9222-9230）+ 一个 takeover 端口（9220）。
 * 每个 create 端口 = 一个独立的隔离环境。
 *
 * 核心设计：
 * - 复用现有的 plugin 连接（扩展只连一次 9221/plugin）
 * - 每个 create 端口有独立的 PortSession（targetId 集合）
 * - 命令转发给 plugin 时带 __portIndex 标记
 * - plugin 返回的事件按 __portIndex 路由回对应端口
 * - 对齐原生 Chrome：多客户端共享、断开不清理 tab
 */

const http = require('http');
const WebSocket = require('ws');
const { CONFIG } = require('./config');

class PortPoolManager {
  constructor(mainProxy) {
    this.mainProxy = mainProxy;  // 现有 proxy 的引用（拿 plugin 连接）
    this.createServers = [];      // [http.Server] 每个 create 端口一个
    this.createWss = [];          // [WebSocket.Server] 每个 create 端口一个
    this.portSessions = [];       // [PortSession] 每个 create 端口一个
    this.takeoverServer = null;
    this.takeoverWss = null;
    this.targetToPort = new Map();   // targetId → portIndex（事件路由用）
    this.sessionToPort = new Map();  // CDP sessionId → portIndex
  }

  /**
   * PortSession：一个 create 端口的隔离状态
   */
  static PortSession = class {
    constructor(portIndex, port) {
      this.portIndex = portIndex;
      this.port = port;
      this.targetIds = new Set();        // 这个端口创建的所有 targetId
      this.tabIds = new Set();           // Chrome tabId（扩展端返回的）
      this.clients = new Set();          // 连接到这个端口的 client WebSocket
      this.cdpIdCounter = 1;             // CDP 命令 id 计数器
      this.pendingRequests = new Map();  // id → {clientWs, resolve, reject}
      this.targetToClient = new Map();   // targetId → clientWs（attachToTarget 时绑定）
      this.browserWsUrl = null;          // /json/version 返回的 webSocketDebuggerUrl
    }
  };

  start() {
    // 启动 create 端口（9222-9230）
    for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
      const port = CONFIG.POOL_START + i;
      this._startCreatePort(i, port);
    }

    // 启动 takeover 端口（9220）
    this._startTakeoverPort();

    console.log(`\n[PORT POOL] Started: takeover=${CONFIG.POOL_TAKEOVER_PORT}, create=${CONFIG.POOL_START}-${CONFIG.POOL_START + CONFIG.POOL_SIZE - 1}`);
  }

  _startCreatePort(portIndex, port) {
    const session = new PortPoolManager.PortSession(portIndex, port);
    this.portSessions[portIndex] = session;

    const server = http.createServer();
    const wss = new WebSocket.Server({ noServer: true });
    this.createWss[portIndex] = wss;

    // HTTP 请求（非 upgrade）
    server.on('request', (req, res) => {
      this._handleHttp(req, res, session);
    });

    // WebSocket upgrade
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;
      if (path !== '/client' && !path.startsWith('/client/') &&
          !path.startsWith('/devtools/browser/') && !path.startsWith('/devtools/page/')) {
        socket.destroy();
        return;
      }
    wss.handleUpgrade(req, socket, head, (ws) => {
      this._handleClientConnect(ws, req, session);
    });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[PORT POOL] Port ${port} in use, skipping create port ${portIndex}`);
      } else {
        console.error(`[PORT POOL] Create port ${port} error:`, err.message);
      }
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`[CREATE PORT ${portIndex}] Listening on ${port}`);
    });

    this.createServers[portIndex] = server;
    this.createWss[portIndex] = wss;
  }

  _startTakeoverPort() {
    const port = CONFIG.POOL_TAKEOVER_PORT;
    const server = http.createServer((req, res) => {
      // takeover 的 HTTP 请求转发给主 proxy 的 handleHttpRequest
      req._takeoverMode = true;
      this.mainProxy.handleHttpRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      req._takeoverMode = true;
      // takeover 的 WS 连接转发给主 proxy 的 wss
      this.mainProxy.handleTakeoverUpgrade(req, socket, head);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[PORT POOL] Takeover port ${port} in use`);
      }
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`[TAKEOVER POOL] Listening on ${port}`);
    });

    this.takeoverServer = server;
  }

  /**
   * HTTP 请求处理（/json/version, /json/list 等）
   * 每个 create 端口只返回自己的 target
   */
  async _handleHttp(req, res, session) {
    const url = new URL(req.url, `http://localhost:${session.port}`);
    const path = url.pathname;

    if (path === '/json/version') {
      // 返回版本信息，webSocketDebuggerUrl 指向当前端口
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'Chrome/131.0.6778.86 (cdp-tunnel)',
        'Protocol-Version': '1.3',
        'User-Agent': 'cdp-tunnel/3.0',
        'webSocketDebuggerUrl': `ws://localhost:${session.port}/devtools/browser/pool_${session.portIndex}`
      }));
      return;
    }

    if (path === '/json' || path === '/json/list') {
      // 只返回这个端口的 target（从主 proxy 拿全量后过滤）
      const allTargets = await this.mainProxy.getAllTargets(session.portIndex);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(allTargets));
      return;
    }

    if (path === '/json/new') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Use Target.createTarget via WebSocket' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Client WebSocket 连接处理
   */
  _handleClientConnect(ws, req, session) {
    session.clients.add(ws);

    // 找到 plugin 连接（从主 proxy 获取）
    const pluginWs = this.mainProxy.getPluginConnection();
    if (!pluginWs) {
      ws.close(1011, 'No extension connected');
      return;
    }

    // 合成输入命令需要 ensureVisible（和 forward.js 的逻辑一致）
    const SYNTHETIC_INPUT = ['Input.dispatchKeyEvent', 'Input.dispatchMouseEvent'];

    // 消息处理：client → plugin（带 portIndex 标记）
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.id !== undefined) {
        // 合成输入命令：先 bringToFront + 等待，再发原命令
        if (SYNTHETIC_INPUT.indexOf(msg.method) >= 0 && msg.sessionId) {
          await this._ensureVisible(session, pluginWs, msg.sessionId);
        }

        // 命令：分配新 id，记录映射（含 method 名供响应后处理），转发给 plugin
        const newId = `pool${session.portIndex}_${msg.id}`;
        session.pendingRequests.set(newId, {
          originalId: msg.id,
          method: msg.method,
          clientWs: ws
        });

        const forwarded = { ...msg, id: newId, __portIndex: session.portIndex };
        pluginWs.send(JSON.stringify(forwarded));
      } else {
        // 无 id 的消息（事件），直接转发
        pluginWs.send(JSON.stringify({ ...msg, __portIndex: session.portIndex }));
      }
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      console.log(`[PORT ${session.port}] Client disconnected (remaining: ${session.clients.size})`);
      // 对齐原生 Chrome：断开不清理 tab
    });

    ws.on('error', () => {
      session.clients.delete(ws);
    });
  }

  /**
   * 处理从 plugin 返回的消息（按 portIndex 路由回对应端口的 client）
   * 返回 true 表示已处理（端口池的消息），false 表示不是端口池的
   */
  handlePluginMessage(msg, pluginWs) {
    if (!msg) return false;

    // 1. 响应消息：id 以 pool 开头
    if (msg.id && typeof msg.id === 'string' && msg.id.startsWith('pool')) {
      // 内部命令（ensureVisible 用的）响应直接丢弃
      if (msg.id.includes('_internal')) {
        return true;
      }
      const match = msg.id.match(/^pool(\d+)_(.+)$/);
      if (!match) return false;

      const portIndex = parseInt(match[1]);
      const originalId = match[2];
      const session = this.portSessions[portIndex];
      if (!session) return false;

      const pending = session.pendingRequests.get(msg.id);
      session.pendingRequests.delete(msg.id);

      // 如果是 createTarget 响应，记录 targetId → portIndex 归属
      if (msg.result && msg.result.targetId) {
        session.targetIds.add(msg.result.targetId);
        this.targetToPort.set(msg.result.targetId, portIndex);
        console.log(`[PORT POOL] targetId=${msg.result.targetId.slice(0,12)} → port ${session.port}`);
      }

      // 如果是 attachToTarget 响应，记录 sessionId → portIndex
      if (msg.result && msg.result.sessionId) {
        this.sessionToPort.set(msg.result.sessionId, portIndex);
      }

      // 如果是 getTargets 响应，按 portIndex 过滤 targetInfos
      if (pending && pending.method === 'Target.getTargets' && msg.result && msg.result.targetInfos) {
        msg.result.targetInfos = msg.result.targetInfos.filter(t => session.targetIds.has(t.targetId));
        console.log(`[PORT POOL] getTargets filtered: ${msg.result.targetInfos.length} targets for port ${session.port}`);
      }

      // 恢复原始 id，发给发起请求的 client
      const response = { ...msg, id: this._parseOriginalId(originalId) };
      if (pending && pending.clientWs && pending.clientWs.readyState === WebSocket.OPEN) {
        pending.clientWs.send(JSON.stringify(response));
      } else {
        // 广播给这个端口的所有 client
        this._broadcastToPort(portIndex, response);
      }
      return true;
    }

    // 2. 事件消息（无 id）：按 targetId 或 sessionId 路由
    if (msg.method && msg.params) {
      // 诊断：打印所有未匹配到的事件
      let targetId = null;
      if (msg.params.targetId) targetId = msg.params.targetId;
      else if (msg.params.targetInfo && msg.params.targetInfo.targetId) targetId = msg.params.targetInfo.targetId;

      if (targetId) {
        const portIndex = this.targetToPort.get(targetId);
        if (portIndex !== undefined) {
          const session = this.portSessions[portIndex];
          if (session) {
            this._broadcastToPort(portIndex, msg);
            return true;
          }
        }
      }

      // sessionId 路由（Network/Screencast/Input 等 session 事件）
      if (msg.sessionId) {
        const portIndex = this.sessionToPort.get(msg.sessionId);
        if (portIndex !== undefined) {
          this._broadcastToPort(portIndex, msg);
          return true;
        }
      }
    }

    return false;  // 不是端口池的消息
  }

  _parseOriginalId(idStr) {
    const n = parseInt(idStr);
    return isNaN(n) ? idStr : n;
  }

  /**
   * 让 tab 变 visible：Page.bringToFront + 等待 + 恢复焦点。
   * 内部命令用 _internal_ 前缀，handlePluginMessage 会丢弃它们的响应。
   */
  async _ensureVisible(session, pluginWs, sessionId) {
    const pfx = `pool${session.portIndex}_internal`;

    // 1. 保存焦点
    pluginWs.send(JSON.stringify({
      id: `${pfx}_save_${Date.now()}`,
      method: 'Runtime.evaluate',
      params: { expression: '(function(){var el=document.activeElement;if(el&&el!==document.body&&el.focus){el.setAttribute("data-cdp-saved-focus","1");return 1}return 0})()', returnByValue: true },
      sessionId, __portIndex: session.portIndex
    }));

    // 2. bringToFront
    pluginWs.send(JSON.stringify({
      id: `${pfx}_front_${Date.now()}`,
      method: 'Page.bringToFront',
      params: {},
      sessionId, __portIndex: session.portIndex
    }));

    // 3. 等 visibilitychange + 双 rAF（renderer 完成切换）
    pluginWs.send(JSON.stringify({
      id: `${pfx}_vis_${Date.now()}`,
      method: 'Runtime.evaluate',
      params: {
        expression: 'new Promise(function(r){function ok(){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1)})})}if(document.visibilityState==="visible"){ok()}else{var d=function(){if(document.visibilityState==="visible"){document.removeEventListener("visibilitychange",d);ok()}};document.addEventListener("visibilitychange",d);setTimeout(function(){document.removeEventListener("visibilitychange",d);ok()},3000)}})',
        awaitPromise: true
      },
      sessionId, __portIndex: session.portIndex
    }));

    // 给 bringToFront + visibility 等待时间（不等具体响应，内部命令响应被丢弃）
    await new Promise(r => setTimeout(r, 300));

    // 4. 恢复焦点
    pluginWs.send(JSON.stringify({
      id: `${pfx}_restore_${Date.now()}`,
      method: 'Runtime.evaluate',
      params: { expression: '(function(){var el=document.querySelector("[data-cdp-saved-focus]");if(el){el.removeAttribute("data-cdp-saved-focus");el.focus();return 1}return 0})()', returnByValue: true },
      sessionId, __portIndex: session.portIndex
    }));

    await new Promise(r => setTimeout(r, 50));
  }

  _broadcastToPort(portIndex, msg) {
    const session = this.portSessions[portIndex];
    if (!session) return;
    const data = JSON.stringify(msg);
    session.clients.forEach(clientWs => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });
  }

  stop() {
    this.createServers.forEach(s => { try { s.close(); } catch {} });
    if (this.takeoverServer) { try { this.takeoverServer.close(); } catch {} }
    console.log('[PORT POOL] Stopped');
  }
}

module.exports = { PortPoolManager };
