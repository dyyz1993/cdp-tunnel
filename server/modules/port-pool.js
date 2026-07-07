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
    this.mainProxy = mainProxy;
    this.idCounter = 0; // 全局唯一 id 计数器  // 现有 proxy 的引用（拿 plugin 连接）
    this.createServers = [];      // [http.Server] 每个 create 端口一个
    this.createWss = [];          // [WebSocket.Server] 每个 create 端口一个
    this.portSessions = [];       // [PortSession] 每个 create 端口一个（端口池端口用）
    this.keySessions = new Map(); // apiKey → PortSession（主端口按 key 隔离，一 key 一 session）
    this._keyToPortIndex = new Map();  // apiKey → portIndex（key 到端口池端口的映射）
    this.takeoverServer = null;
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
      this.targetUrls = new Map();       // targetId → url（navigate 时更新）
      this.tabIds = new Set();           // Chrome tabId（扩展端返回的）
      this.clients = new Set();          // 连接到这个端口的 client WebSocket
      this.cdpIdCounter = 1;             // CDP 命令 id 计数器
      this.pendingRequests = new Map();  // id → {clientWs, resolve, reject}
      this.targetToClient = new Map();   // targetId → clientWs（attachToTarget 时绑定）
      this.sessionToClient = new Map();  // sessionId → clientWs（事件精确路由用）
      this.browserWsUrl = null;          // /json/version 返回的 webSocketDebuggerUrl
    }
  };

  start() {
    // 端口池第 0 个端口 = 主端口（9221），复用主 server 的 /client 入口（不另开 http.Server）
    this._setupMainPortSession(0, CONFIG.PORT);

    // 启动 create 端口（9231-9239），portIndex 从 1 开始（0 留给主端口）
    for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
      const port = CONFIG.POOL_START + i;
      this._startCreatePort(i + 1, port);
    }

    // 启动 takeover 端口（9220）
    this._startTakeoverPort();

    console.log(`\n[PORT POOL] Started: takeover=${CONFIG.POOL_TAKEOVER_PORT}, create=${CONFIG.PORT}(main) + ${CONFIG.POOL_START}-${CONFIG.POOL_START + CONFIG.POOL_SIZE - 1}`);
  }

  /**
   * 主端口（9221）作为端口池第 0 个端口：只建 PortSession，不开 http.Server。
   * 9221 的 HTTP 和 upgrade 由主 proxy-server 处理，但走端口池的隔离逻辑。
   */
  _setupMainPortSession(portIndex, port) {
    const session = new PortPoolManager.PortSession(portIndex, port);
    this.portSessions[portIndex] = session;
    console.log(`[CREATE PORT ${portIndex}] Main port ${port} (reuses main server)`);
  }

  /**
   * 按 key 获取/分配独立的端口池端口 session（一 key 一 session，完全隔离）
   * 主端口(9221)的 /client 连接按 key 路由到端口池端口(9231+)的 session。
   * 复用端口池端口的全部隔离逻辑（targetIds/事件路由/分组），不动 handlePluginMessage。
   *
   * @returns PortSession 或 null（无可用端口时）
   */
  _getKeySession(apiKey) {
    if (!this._keyToPortIndex) this._keyToPortIndex = new Map();
    // 已分配过 → 直接返回
    if (this._keyToPortIndex.has(apiKey)) {
      return this.portSessions[this._keyToPortIndex.get(apiKey)];
    }
    // 找一个未分配的端口池端口（portIndex >= 1）
    const usedIndexes = new Set(this._keyToPortIndex.values());
    for (let i = 1; i < this.portSessions.length; i++) {
      if (this.portSessions[i] && !usedIndexes.has(i)) {
        this._keyToPortIndex.set(apiKey, i);
        this.portSessions[i].apiKey = apiKey;  // 标记这个 session 属于哪个 key
        console.log(`[KEY SESSION] key=${apiKey.slice(0, 16)}... → portIndex=${i} (port ${this.portSessions[i].port})`);
        return this.portSessions[i];
      }
    }
    // 端口池满（所有端口都已分配）→ 复用主端口 session（降级，不隔离）
    console.warn(`[KEY SESSION] port pool exhausted, key=${apiKey.slice(0, 16)}... falling back to shared main session`);
    return null;
  }

  _startCreatePort(portIndex, port) {
    const session = new PortPoolManager.PortSession(portIndex, port);
    this.portSessions[portIndex] = session;

    const server = http.createServer();
    this.createServers[portIndex] = server;

    server.on('request', (req, res) => {
      this._handleHttp(req, res, session);
    });

    server.on('upgrade', (req, socket, head) => {
      req._poolPortIndex = portIndex;
      req._poolPort = port;
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      // 只接受 client 连接（plugin 连 9221）
      if (path !== '/client' && !path.startsWith('/client/') &&
          !path.startsWith('/devtools/browser/') && !path.startsWith('/devtools/page/')) {
        socket.destroy();
        return;
      }

      this.mainProxy.handlePoolUpgrade(req, socket, head, portIndex, port);
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

    if (path === '/json/version' || path === '/json/version/') {
      // 返回版本信息，webSocketDebuggerUrl 指向当前端口
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'Chrome/131.0.6778.86 (cdp-tunnel)',
        'Protocol-Version': '1.3',
        'User-Agent': 'cdp-tunnel/3.0',
        'webSocketDebuggerUrl': `ws://localhost:${session.port}/client`
      }));
      return;
    }

    if (path === '/json' || path === '/json/' || path === '/json/list' || path === '/json/list/') {
      // 返回这个端口创建的 tab 列表
      // 从 session.targetIds 构建（这些是 createTarget 时记录的）
      const targets = [];
      for (const targetId of session.targetIds) {
        targets.push({
          id: targetId,
          type: 'page',
          url: session.targetUrls.get(targetId) || 'about:blank',
          title: '',
          webSocketDebuggerUrl: `ws://localhost:${session.port}/devtools/page/${targetId}`
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
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
    // 鉴权：从 URL 提取 key，找到对应的 plugin（一 key 一浏览器）
    let apiKey = null;
    try {
      const url = new URL(req.url, `http://localhost:${session.port}`);
      apiKey = url.searchParams.get('key') || null;
    } catch {}

    // 如果有 SaaS 鉴权（HAS_SAAS），校验 key
    if (this.mainProxy.validateClientKey) {
      const valid = this.mainProxy.validateClientKey(apiKey);
      if (!valid) {
        ws.close(4001, 'Invalid or missing API key');
        return;
      }
    }

    ws.apiKey = apiKey;  // 记录到 ws，后续命令转发时带上

    // 主端口（portIndex === 0）：按 key 路由到独立的端口池端口 session
    // 每个 key 分配一个端口池端口（portSessions[1..N]），实现完全隔离
    //   - targetIds 独立（listtabs 只看自己的）
    //   - 事件路由用现有 targetToPort（按 portIndex，不动 handlePluginMessage）
    //   - 分组名按 key（阶段1已实现）
    // 无 key 或端口池满时，fallback 到主端口共享 session（兼容）
    if (session.portIndex === 0 && apiKey) {
      const keySession = this._getKeySession(apiKey);
      if (keySession) session = keySession;
    }

    session.clients.add(ws);

    const pluginWs = this.mainProxy.getPluginConnection(apiKey);
    if (!pluginWs) {
      ws.close(1011, apiKey ? 'No browser connected for this key' : 'No extension connected');
      return;
    }

    // 通知扩展有 client 连接（带端口号作为分组标识）
    // 对齐原生 CDP：不创建任何隐式的 about:blank 页面。
    // 原生 chrome --remote-debugging-port 在 client 连接后不创建任何 target，
    // 只在 connectOverCDP 的 setAutoAttach 期间发现已有 target。
    // （移除旧版 warmup 逻辑：它用 Target.createTarget 创建临时 about:blank 再关闭，
    //   但时间窗口内 Playwright 的 setAutoAttach 会发现它，导致用户看到多余空白页。）
    // clientId 固定为 pool_{port}，让扩展为每个端口建一个独立分组
    // __groupName 带 key 名称，让扩展用 key 名称命名 Chrome 分组（一眼看出是谁的浏览器）
    const poolClientId = `pool_${session.port}`;
    pluginWs._lastPoolClientId = poolClientId;
    pluginWs.send(JSON.stringify({
      type: 'client-connected',
      clientId: poolClientId,
      __mode: 'create',
      __connectionTag: String(session.port),
      __groupName: pluginWs.apiKeyName || null
    }));

    // 合成输入命令需要 ensureVisible（和 forward.js 的逻辑一致）
    const SYNTHETIC_INPUT = ['Input.dispatchKeyEvent', 'Input.dispatchMouseEvent'];

    // 消息处理：client → plugin（带 portIndex 标记）
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.id !== undefined) {
        // createTarget 串行化 + 标记 pending
        if (msg.method === 'Target.createTarget') {
          while (session.createTargetLock) { await session.createTargetLock; }
          session.createTargetLock = new Promise(r => { session._releaseCreateTarget = r; });
          session.pendingCreate = true; // 标记：下一个 targetCreated 事件归属这个端口
        }

        // 合成输入命令：先 bringToFront + 等待，再发原命令
        if (SYNTHETIC_INPUT.indexOf(msg.method) >= 0 && msg.sessionId) {
          await this._ensureVisible(session, pluginWs, msg.sessionId);
        }

        // 命令：分配全局唯一 id（避免不同 client 的 msg.id 冲突）
        const uniqueId = ++this.idCounter;
        const newId = `pool${session.portIndex}_${uniqueId}`;
        // 记录 originalId（用于响应时恢复）
        if (!ws._origIds) ws._origIds = new Map();
        ws._origIds.set(uniqueId, msg.id);
        session.pendingRequests.set(newId, {
          originalId: msg.id,
          method: msg.method,
          clientWs: ws,
          params: msg.params,
          sessionId: msg.sessionId
        });

        const forwarded = { ...msg, id: newId, __portIndex: session.portIndex, __clientId: `pool_${session.port}` };
        pluginWs.send(JSON.stringify(forwarded));
      } else {
        // 无 id 的消息（事件），直接转发
        pluginWs.send(JSON.stringify({ ...msg, __portIndex: session.portIndex }));
      }
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      // 内存泄漏修复：清理该 client 的 pendingRequests 和 sessionToClient 引用，
      // 避免 plugin 永不响应时 entry 一直挂着 ws 对象
      if (ws._origIds) ws._origIds.clear();
      for (const [reqId, pending] of session.pendingRequests.entries()) {
        if (pending.clientWs === ws) session.pendingRequests.delete(reqId);
      }
      for (const [sid, cws] of session.sessionToClient.entries()) {
        if (cws === ws) session.sessionToClient.delete(sid);
      }
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

    // 1. 响应消息：id 以 pool 开头（排除事件——事件有 method 字段）
    if (msg.id && typeof msg.id === 'string' && msg.id.startsWith('pool') && !msg.method) {
      // 内部命令响应（_ensureVisible 的 bringToFront/waitVis 等）：丢弃，不路由给 client
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

      // 如果是 createTarget 响应
      if (pending && pending.method === 'Target.createTarget') {
        console.log('[PORT POOL] createTarget resp: ' + JSON.stringify(msg.result).slice(0, 80) + ' pending=' + !!pending);
      }
      if (msg.result && msg.result.targetId) {
        const tid = msg.result.targetId;
        session.targetIds.add(tid);
        session.targetUrls.set(tid, pending?.params?.url || 'about:blank');
        this.targetToPort.set(tid, portIndex);
        // 释放 createTarget 锁
        if (session._releaseCreateTarget) {
          session._releaseCreateTarget();
          session._releaseCreateTarget = null;
          session.createTargetLock = null;
        }
      }

      // 如果是 Page.navigate 响应，更新 targetId 的 url
      if (pending && pending.method === 'Page.navigate' && pending.sessionId && msg.result) {
        // 找 sessionId 对应的 targetId
        for (const [tid, pidx] of this.targetToPort.entries()) {
          if (pidx === portIndex) {
            // 用 pending.params.url 更新
            if (pending.params?.url) {
              session.targetUrls.set(tid, pending.params.url);
            }
          }
        }
      }

      // 如果是 attachToTarget 响应，记录 sessionId → portIndex + 发起请求的 client
      if (msg.result && msg.result.sessionId) {
        this.sessionToPort.set(msg.result.sessionId, portIndex);
        // 记录 sessionId → 哪个 client 发起的（用于精确路由事件）
        session.sessionToClient.set(msg.result.sessionId, pending ? pending.clientWs : null);
      }

      // 如果是 getTargets 响应，按 portIndex 过滤 targetInfos
      if (pending && pending.method === 'Target.getTargets' && msg.result && msg.result.targetInfos) {
        msg.result.targetInfos = msg.result.targetInfos.filter(t => session.targetIds.has(t.targetId));
      }

      // 如果是 closeTarget 响应，清理该 target 的所有映射
      if (pending && pending.method === 'Target.closeTarget' && pending.params && pending.params.targetId) {
        const closedTid = pending.params.targetId;
        session.targetIds.delete(closedTid);
        session.targetUrls.delete(closedTid);
        this.targetToPort.delete(closedTid);
        // sessionId → client 映射在 targetCreated/attachedToTarget 时建立，
        // 但端口池层不维护 sessionId ↔ targetId 反查表，故此处不清理 sessionToClient
        // （session 级隔离下，client 断开时整体清理即可）
      }

      // 恢复原始 id，发给发起请求的 client
      const response = { ...msg, id: pending ? pending.originalId : this._parseOriginalId(originalId) };
      delete response.__portIndex;
      delete response.__clientId;
      delete response.type;
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
      // 提取 targetId（attachedToTarget 的在 params.targetInfo.targetId）
      let targetId = null;
      if (msg.params.targetId) targetId = msg.params.targetId;
      else if (msg.params.targetInfo && msg.params.targetInfo.targetId) targetId = msg.params.targetInfo.targetId;

      // 关键：attachedToTarget 事件带 sessionId 时，必须注册 sessionToPort，
      // 否则后续该 session 的 Page.*/Runtime.* 事件无法路由（Playwright evaluate 会卡死）。
      // 这一步独立于 targetId 是否已知——auto-attach 场景下 targetId 可能尚未在 targetToPort 注册。
      // 归属端口：优先用 targetId 查 targetToPort；查不到时，找唯一一个 pendingCreate 的端口，
      // 再查不到则归到端口 0（POOL_SIZE=0 时只有端口 0；多端口时靠 createTarget 响应补注册 targetId→port）
      if (msg.method === 'Target.attachedToTarget' && msg.params.sessionId) {
        let portIdx = this.targetToPort.get(targetId);
        if (portIdx === undefined) {
          // 找 pendingCreate 的端口（createTarget 响应还没到，但事件先到了）
          for (let pi = 0; pi < this.portSessions.length; pi++) {
            if (this.portSessions[pi] && this.portSessions[pi].pendingCreate) { portIdx = pi; break; }
          }
        }
        if (portIdx === undefined) portIdx = 0;  // 兜底：归到主端口
        const sess = this.portSessions[portIdx];
        if (sess) {
          if (targetId) {
            sess.targetIds.add(targetId);
            this.targetToPort.set(targetId, portIdx);
          }
          this.sessionToPort.set(msg.params.sessionId, portIdx);
          sess.sessionToClient.delete(msg.params.sessionId);  // auto-attach：广播
        }
      }

      // 内存泄漏修复：target 销毁/detach 时清理 sessionToPort、targetToPort、sessionToClient
      // 之前只在 closeTarget 响应路径清理，事件路径漏了 → sessionToPort 无界增长
      if (msg.method === 'Target.targetDestroyed' && targetId) {
        const portIdx = this.targetToPort.get(targetId);
        this.targetToPort.delete(targetId);
        if (portIdx !== undefined) {
          const sess = this.portSessions[portIdx];
          if (sess) {
            sess.targetIds.delete(targetId);
            sess.targetUrls.delete(targetId);
          }
        }
      }
      if (msg.method === 'Target.detachedFromTarget') {
        const sid = msg.params.sessionId;
        if (sid) {
          this.sessionToPort.delete(sid);
          const portIdx = this.sessionToPort.get(sid);
          if (portIdx !== undefined && this.portSessions[portIdx]) {
            this.portSessions[portIdx].sessionToClient.delete(sid);
          }
        }
        if (targetId) {
          // detach 也意味着 target 不再活跃，清理 targetToPort（保留 targetIds 历史用于 list）
          this.targetToPort.delete(targetId);
        }
      }

      if (targetId) {
        const portIndex = this.targetToPort.get(targetId);
        if (portIndex !== undefined) {
          const session = this.portSessions[portIndex];
          if (session) {
            this._broadcastToPort(portIndex, msg);
            return true;
          }
        }
        // 竞态处理：targetCreated/attachedToTarget 在 createTarget 响应之前到达
        // 只用 pendingCreate 精确匹配，不广播（广播会导致 sessionId 串）
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.attachedToTarget') {
          for (let pi = 0; pi < this.portSessions.length; pi++) {
            const sess = this.portSessions[pi];
            if (sess && sess.pendingCreate) {
              sess.targetIds.add(targetId);
              sess.targetUrls.set(targetId, 'about:blank');
              this.targetToPort.set(targetId, pi);
              if (msg.method === 'Target.attachedToTarget') sess.pendingCreate = false;
              // attachedToTarget 事件带 sessionId：必须注册 sessionToPort/sessionToClient，
              // 否则后续 Page.*/Runtime.* 等 session 事件无法路由（Playwright newPage 会卡死）
              if (msg.method === 'Target.attachedToTarget' && msg.params && msg.params.sessionId) {
                this.sessionToPort.set(msg.params.sessionId, pi);
                // auto-attach 场景无特定发起 client，广播给该端口所有 client
                sess.sessionToClient.delete(msg.params.sessionId);
              }
              this._broadcastToPort(pi, msg);
              return true;
            }
          }
          // pendingCreate 没匹配到——仍需处理 setAutoAttach 自动触发的 attachedToTarget
          // （Playwright/Puppeteer 的 newPage 走的就是这条路径，不走 createTarget lock）
          // 用 targetToPort 找到归属端口；若 targetId 也未知，广播给所有端口（保守）
          if (msg.method === 'Target.attachedToTarget' && msg.params && msg.params.sessionId) {
            const knownPort = this.targetToPort.get(targetId);
            const portIdx = knownPort !== undefined ? knownPort : 0;
            const sess = this.portSessions[portIdx];
            if (sess) {
              sess.targetIds.add(targetId);
              this.targetToPort.set(targetId, portIdx);
              this.sessionToPort.set(msg.params.sessionId, portIdx);
              sess.sessionToClient.delete(msg.params.sessionId);  // auto-attach：广播
              this._broadcastToPort(portIdx, msg);
            }
            return true;
          }
          // targetCreated 无 pendingCreate 且非 attachedToTarget：记录但不广播
          if (msg.method === 'Target.targetCreated') {
            return true;
          }
        }
      }

      // sessionId 路由（Network/Screencast/Input/Page 等 session 事件）
      if (msg.sessionId) {
        const portIndex = this.sessionToPort.get(msg.sessionId);
        if (portIndex !== undefined) {
          const sess = this.portSessions[portIndex];
          if (sess) {
            // 精确路由：有特定 owner 就单播，否则广播给该端口所有 client
            // （auto-attach 场景无 owner，Playwright/Puppeteer 需要 Page.* 事件）
            const ownerWs = sess.sessionToClient.get(msg.sessionId);
            if (ownerWs && ownerWs.readyState === WebSocket.OPEN) {
              ownerWs.send(JSON.stringify(msg));
            } else {
              this._broadcastToPort(portIndex, msg);
            }
            return true;
          }
        }
        // sessionId 未注册——交给主 proxy 处理（不吞掉）
      }

      // 其他未匹配的事件——交给主 proxy
      return false;
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
