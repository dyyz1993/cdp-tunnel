# CDP Tunnel SaaS 多租户远程浏览器自动化架构设计

> 日期: 2026-05-18
> 基于: cdp-tunnel2 现有 proxy-server.js (v1677行) 改造
> 目标: 支持多租户、多 Plugin 共存、Web 管理平台

---

## 1. 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Nginx (反向代理)                             │
│  :443 → /api/*    → Node API Server :3000                          │
│         /ws/*     → Node WS Gateway :9221                          │
│         /app/*    → React SPA 静态文件                              │
└──────────┬────────────────┬─────────────────────┬───────────────────┘
           │                │                     │
           ▼                ▼                     ▼
┌─────────────────┐ ┌──────────────┐    ┌─────────────────┐
│  API Server     │ │ WS Gateway   │    │  React SPA      │
│  :3000          │ │ :9221        │    │  (管理界面)      │
│                 │ │              │    │                 │
│ - JWT 认证     │ │ 多租户改造    │    │ - 登录/注册     │
│ - 用户 CRUD    │ │ Plugin 注册   │    │ - 浏览器列表    │
│ - 浏览器管理   │ │ Client 路由   │    │ - 远程控制      │
│ - API Key 管理 │ │ 消息隔离      │    │ - API Key 管理  │
│ - 审计日志     │ │ CDP 透传      │    │ - 操作审计      │
└────────┬────────┘ └──────┬───────┘    └─────────────────┘
         │                 │
         ▼                 ▼
┌─────────────────────────────────────────────────────┐
│              SQLite (或 PostgreSQL)                   │
│  - users (租户)                                      │
│  - api_keys (插件认证凭据)                            │
│  - browsers (注册的浏览器实例)                        │
│  - sessions (控制会话记录)                            │
│  - audit_logs (操作审计)                              │
└─────────────────────────────────────────────────────┘

        ┌─────────────────────── 数据流 ───────────────────────┐
        │                                                       │
        │  Chrome Extension (Plugin)                            │
        │  ┌──────────────────┐                                 │
        │  │ background.js    │─── WS ───▶ /ws/plugin          │
        │  │ websocket.js     │◀── WS ───  (携带 API Key)      │
        │  │ debugger.js      │                                 │
        │  └──────────────────┘                                 │
        │                                                       │
        │  Playwright/Puppeteer / Web 远程控制                   │
        │  ┌──────────────────┐                                 │
        │  │ CDP Client       │─── WS ───▶ /ws/client/:bid     │
        │  │ (DevTools UI)    │◀── WS ───  (携带 JWT)          │
        │  └──────────────────┘                                 │
        │                                                       │
        └───────────────────────────────────────────────────────┘
```

### 核心数据流

```
Plugin 连接:                    Client 连接:
  Extension                     Playwright/Web UI
     │                               │
     │  WS /ws/plugin                │  WS /ws/client/:browserId
     │  Header: X-API-Key: xxx       │  Header: Cookie/Query: JWT
     ▼                               ▼
  ┌──────────────────────────────────────────┐
  │           WS Gateway (:9221)             │
  │                                          │
  │  1. 验证 API Key → 解析 userId          │
  │  2. 注册 plugin 到该 userId 的命名空间   │
  │  3. 验证 JWT → 解析 userId              │
  │  4. 检查 userId 是否拥有 browserId      │
  │  5. 建立 Client ↔ Plugin 专用通道       │
  │  6. 双向透传 CDP 消息                    │
  └──────────────────────────────────────────┘
```

---

## 2. 认证体系

### 2.1 插件认证 (API Key)

插件使用 **API Key** 认证，而非用户名密码。原因：
- 插件是无人值守运行，无法交互式登录
- API Key 可在 Web 管理平台生成/吊销
- 一个用户可拥有多个 API Key（多台电脑）

**连接流程:**

```
1. 用户在 Web 平台生成 API Key: `ak_live_xxxxxxxxxxxxxxxx`
2. 在 Chrome 插件设置页配置: 服务器地址 + API Key
3. 插件连接 WS 时携带:
   - URL: wss://domain.com/ws/plugin
   - Header: X-API-Key: ak_live_xxxxxxxxxxxxxxxx
   - 或首条消息: { type: "auth", apiKey: "ak_live_xxxxxxxxxxxxxxxx" }

4. 服务端验证:
   - 查询 api_keys 表，找到 key → userId
   - 检查 key 是否有效 (未过期/未吊销)
   - 将该 plugin 连接注册到该 userId 的命名空间
   - 返回: { type: "connected", role: "plugin", browserId: "b_xxx", userId: "u_xxx" }
```

**API Key 格式:**
```
ak_live_[32字符随机hex]    # 生产环境
ak_test_[32字符随机hex]    # 测试环境
```

### 2.2 用户认证 (JWT)

Web 管理平台和 CDP Client 使用 **JWT** 认证：

```
登录流程:
POST /api/v1/auth/login
  { email, password }
  → { token: "eyJ...", user: { id, email, name } }

JWT Payload:
{
  "sub": "user_xxx",       // userId
  "email": "a@b.com",
  "iat": 1716000000,
  "exp": 1716086400         // 24h 有效期
}
```

### 2.3 多租户隔离矩阵

| 操作 | 认证方式 | 隔离粒度 | 校验位置 |
|------|---------|---------|---------|
| Plugin 连接 | API Key | userId | WS Gateway 首条消息 |
| Client WS 连接 | JWT | userId + browserId | WS Gateway upgrade |
| Web API 请求 | JWT Cookie | userId | API 中间件 |
| HTTP /json/list | JWT Query | userId + browserId | HTTP Handler |

---

## 3. 多 Plugin 共存改造方案

### 3.1 当前问题分析

proxy-server.js 中以下代码阻止多 Plugin 共存：

```javascript
// L502-518: 新 plugin 连入踢掉旧 plugin
if (pluginConnections.size > 0) {
    pluginConnections.forEach(oldWs => {
        oldWs.close(1001, 'Server restarted');
    });
}

// L521-526: 清空所有全局状态
sessionToClientId.clear();
pendingAttachRequests.clear();
connectionPairs.clear();
```

全局状态不隔离:
```javascript
// L148-162: 所有状态共享，无租户隔离
const pluginConnections = new Set();
const clientConnections = new Set();
const connectionPairs = new Map();
const sessionToClientId = new Map();
const globalRequestIdMap = new Map();
const targetIdToClientId = new Map();
```

### 3.2 改造方案: TenantNamespace 类

将全局状态封装为 **按租户隔离的命名空间**，原有逻辑不变，只是从全局变量改为命名空间内的属性。

```javascript
class TenantNamespace {
    constructor(userId) {
        this.userId = userId;

        // 原 proxy-server.js 全局状态 → 租户私有状态
        this.pluginConnections = new Set();
        this.clientConnections = new Set();
        this.connectionPairs = new Map();
        this.clientById = new Map();
        this.sessionToClientId = new Map();
        this.pendingAttachRequests = new Map();
        this.clientIdToPlugin = new Map();
        this.globalRequestIdMap = new Map();
        this.targetIdToClientId = new Map();
        this.pendingAttachedEvents = new Map();
        this.pendingTargetCreatedEvents = new Map();
        this.browserContextToClientId = new Map();
        this.clientIdToBrowserContext = new Map();
        this.globalRequestIdCounter = 0;

        this.cachedTargets = [];
        this.lastTargetsUpdate = 0;
        this.cachedBrowserVersion = null;

        // browserId → pluginWs 映射 (一个用户可以有多个浏览器)
        this.browsers = new Map();
    }
}
```

### 3.3 改造对照表

| 原 proxy-server.js | 改造后 |
|---|---|
| `const pluginConnections = new Set()` | `namespace.pluginConnections` |
| `const clientConnections = new Set()` | `namespace.clientConnections` |
| `const connectionPairs = new Map()` | `namespace.connectionPairs` |
| `handlePluginConnection(ws)` | `handlePluginConnection(ws, namespace)` |
| `handleClientConnection(ws)` | `handleClientConnection(ws, namespace, browserId)` |
| 新 plugin 踢掉旧 plugin (L502-518) | **删除此逻辑**，改为注册到 namespace |
| `pluginConnections.size === 0` | `namespace.pluginConnections.size === 0` |

### 3.4 改造步骤 (最小侵入)

1. **新增** `TenantManager` 类管理所有租户命名空间
2. **抽取** `handlePluginConnection` / `handleClientConnection` 中所有全局变量引用，改为通过 `namespace` 参数访问
3. **删除** L502-518 的踢人逻辑
4. **删除** L521-526 的全局状态清空
5. **保留** 所有消息路由、CDP 透传逻辑不变（仅变量引用从全局改为 namespace 属性）

```javascript
// 全局租户管理器
const tenants = new Map(); // userId → TenantNamespace

function getOrCreateNamespace(userId) {
    if (!tenants.has(userId)) {
        tenants.set(userId, new TenantNamespace(userId));
    }
    return tenants.get(userId);
}
```

### 3.5 连接改造后的 handlePluginConnection 伪代码

```javascript
function handlePluginConnection(ws, clientInfo) {
    // 1. 等待 auth 消息
    ws.once('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type !== 'auth' || !msg.apiKey) {
            ws.close(4001, 'Authentication required');
            return;
        }

        // 2. 验证 API Key
        const { userId, browserId } = verifyApiKey(msg.apiKey);
        if (!userId) {
            ws.close(4003, 'Invalid API Key');
            return;
        }

        // 3. 获取租户命名空间
        const ns = getOrCreateNamespace(userId);

        // 4. 注册 plugin（不踢人！）
        const id = generateId('plugin');
        ws.id = id;
        ws.browserId = browserId;
        ws.userId = userId;
        ns.pluginConnections.add(ws);
        ns.browsers.set(browserId, ws);

        // 5. 后续逻辑与原来相同，只是用 ns.xxx 替代全局变量
        // ...
    });
}
```

---

## 4. Client 路由

### 4.1 路由规则

```
原路由:  ws://host:9221/client               → 自动配对唯一 plugin
新路由:  wss://host/ws/client/:browserId      → 连接指定 browserId 的 plugin
         wss://host/ws/devtools/browser/:browserId
         wss://host/ws/devtools/page/:targetId?browserId=xxx
```

### 4.2 HTTP CDP 端点改造

```
原端点:  GET /json/version             → 返回唯一 browser 信息
         GET /json/list                → 返回唯一 browser 的所有 tab

新端点:  GET /api/v1/browsers           → 列出当前用户的所有在线浏览器
         GET /api/v1/b/:browserId/json/version   → 指定 browser 的版本信息
         GET /api/v1/b/:browserId/json/list      → 指定 browser 的 tab 列表
         GET /api/v1/b/:browserId/json/protocol   → CDP 协议描述
```

### 4.3 Playwright 兼容性

Playwright 通过 `connectOverCDP` 连接，期望标准 CDP HTTP 端点：

```typescript
// 用户使用方式
const browser = await chromium.connectOverCDP(
    'wss://domain.com/api/v1/b/b_xxx/devtools/browser/b_xxx',
    {
        headers: { 'Authorization': 'Bearer eyJ...' }
    }
);
```

为此需要改造 HTTP Handler:

```javascript
// 路由: /api/v1/b/:browserId/json/*
async function handleBrowserJsonRequest(req, res) {
    const userId = verifyJWT(extractToken(req));
    const browserId = extractBrowserId(req.url);
    const ns = tenants.get(userId);

    if (!ns || !ns.browsers.has(browserId)) {
        res.writeHead(404);
        res.end('Browser not found');
        return;
    }

    const pluginWs = ns.browsers.get(browserId);
    // ... 原有逻辑，通过 pluginWs 请求 CDP 信息
}
```

---

## 5. Web 管理界面

### 5.1 页面结构

```
/                      → 登录页 (未登录) / 仪表盘 (已登录)
/login                 → 登录页
/register              → 注册页 (或邀请码注册)
/dashboard             → 仪表盘
/browsers              → 浏览器列表 (在线/离线)
/browsers/:id          → 浏览器详情 + 远程控制入口
/browsers/:id/control  → 远程控制界面 (内嵌 DevTools)
/settings              → 设置
/settings/api-keys     → API Key 管理
/settings/profile      → 个人信息
/audit-log             → 操作审计日志
```

### 5.2 功能列表

#### 仪表盘
- 在线浏览器数量 / 总浏览器数
- 当前活跃控制会话数
- 最近连接/断开事件
- 快速操作: 连接浏览器、生成 API Key

#### 浏览器列表
| 字段 | 说明 |
|------|------|
| 名称 | 用户自定义浏览器名称 |
| 状态 | 🟢 在线 / 🔴 离线 / 🟡 控制中 |
| 最后上线 | 最后一次 plugin 心跳时间 |
| Chrome 版本 | 通过 Browser.getVersion 获取 |
| 操作 | 远程控制 / 查看详情 / 删除 |

#### 远程控制界面
- 使用 [chrome-devtools-frontend](https://github.com/nicedoc/chrome-devtools-frontend) 或 iframe 嵌入 DevTools
- 连接: `devtools://devtools/bundled/inspector.html?wss=domain.com/ws/devtools/page/:targetId&browserId=xxx`
- 或自建轻量级控制面板: 截屏 + 基本导航 + Console

#### API Key 管理
- 创建新 Key (可备注用途)
- 复制 Key (仅创建时显示完整)
- 吊销 Key
- 每个 Key 显示: 最后使用时间、关联浏览器数

#### 操作审计
- 浏览器上线/下线
- 控制会话开始/结束
- API Key 创建/吊销
- 敏感操作记录 (navigate, evaluate, screenshot 等)

### 5.3 前端技术选型

```
React 18 + TypeScript
路由: React Router v6
状态: Zustand (轻量，适合中小型应用)
HTTP: fetch + SWR (缓存 + 自动重验证)
UI: Tailwind CSS + Headless UI
构建: Vite
```

---

## 6. 数据模型

### 6.1 ER 图

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    users     │     │   api_keys   │     │  browsers    │
├──────────────┤     ├──────────────┤     ├──────────────┤
│ id (PK)      │──┐  │ id (PK)      │     │ id (PK)      │
│ email        │  │  │ user_id (FK) │◀─┐  │ user_id (FK) │◀─┐
│ password_hash│  └─▶│ key_hash     │  │  │ name         │  │
│ name         │     │ prefix       │  │  │ browser_id   │  │
│ role         │     │ last_used_at │  │  │ status       │  │
│ created_at   │     │ created_at   │  │  │ chrome_ver   │  │
│ updated_at   │     │ expires_at   │  │  │ last_seen_at │  │
└──────────────┘     │ revoked_at   │  │  │ ip_address   │  │
                     └──────────────┘  │  │ os_info      │  │
                                       │  │ created_at   │  │
┌──────────────┐     ┌──────────────┐  │  │ updated_at   │  │
│  sessions    │     │ audit_logs   │  │  └──────────────┘  │
├──────────────┤     ├──────────────┤  │                    │
│ id (PK)      │     │ id (PK)      │  └────────────────────┘
│ user_id (FK) │     │ user_id (FK) │
│ browser_id   │     │ action       │
│ client_ip    │     │ resource_type│
│ started_at   │     │ resource_id  │
│ ended_at     │     │ detail       │
│ duration     │     │ ip_address   │
│ cdp_commands │     │ created_at   │
│ status       │     └──────────────┘
└──────────────┘
```

### 6.2 表结构 (SQLite DDL)

```sql
CREATE TABLE users (
    id          TEXT PRIMARY KEY,           -- 'u_' + nanoid
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,              -- bcrypt hash
    name        TEXT NOT NULL,
    role        TEXT DEFAULT 'user',        -- 'admin' | 'user'
    created_at  INTEGER NOT NULL,           -- unix timestamp ms
    updated_at  INTEGER NOT NULL
);

CREATE TABLE api_keys (
    id          TEXT PRIMARY KEY,           -- 'ak_' + nanoid
    user_id     TEXT NOT NULL REFERENCES users(id),
    key_prefix  TEXT NOT NULL,              -- 前8位, 用于展示: "ak_live_abcd1234..."
    key_hash    TEXT NOT NULL,              -- SHA-256(api_key), 验证用
    name        TEXT,                       -- 备注: "办公室电脑"
    last_used_at INTEGER,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,                    -- NULL = 永不过期
    revoked_at  INTEGER                     -- NULL = 未吊销
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE browsers (
    id              TEXT PRIMARY KEY,       -- 'b_' + nanoid
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT,                   -- 用户自定义名称
    browser_id      TEXT UNIQUE NOT NULL,   -- 运行时生成的 browser_xxx
    status          TEXT DEFAULT 'offline', -- 'online' | 'offline'
    chrome_version  TEXT,
    os_info         TEXT,                   -- 'macOS 14.0 / Chrome 131'
    ip_address      TEXT,
    extension_ver   TEXT,
    last_seen_at    INTEGER,
    registered_at   INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_browsers_user ON browsers(user_id);
CREATE INDEX idx_browsers_status ON browsers(status);

CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,       -- 'sess_' + nanoid
    user_id         TEXT NOT NULL REFERENCES users(id),
    browser_id      TEXT NOT NULL REFERENCES browsers(id),
    client_ip       TEXT,
    client_type     TEXT DEFAULT 'manual',  -- 'manual' | 'playwright' | 'devtools'
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    duration_ms     INTEGER,
    cdp_command_count INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'active'   -- 'active' | 'ended' | 'error'
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_browser ON sessions(browser_id);

CREATE TABLE audit_logs (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    action          TEXT NOT NULL,           -- 'plugin.connect', 'session.start', ...
    resource_type   TEXT,                    -- 'browser', 'api_key', 'session'
    resource_id     TEXT,
    detail          TEXT,                    -- JSON string
    ip_address      TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_time ON audit_logs(created_at);
```

---

## 7. API 设计

### 7.1 认证 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/register` | 用户注册 |
| POST | `/api/v1/auth/login` | 登录，返回 JWT |
| POST | `/api/v1/auth/refresh` | 刷新 JWT |
| POST | `/api/v1/auth/logout` | 登出 (可选黑名单) |

### 7.2 浏览器 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/browsers` | 列出当前用户的浏览器 |
| GET | `/api/v1/browsers/:id` | 浏览器详情 |
| PATCH | `/api/v1/browsers/:id` | 更新浏览器名称 |
| DELETE | `/api/v1/browsers/:id` | 删除离线浏览器 |
| GET | `/api/v1/browsers/:id/targets` | 获取浏览器 CDP targets |

### 7.3 API Key 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/api-keys` | 列出当前用户的 API Keys |
| POST | `/api/v1/api-keys` | 创建新 API Key |
| DELETE | `/api/v1/api-keys/:id` | 吊销 API Key |

### 7.4 CDP 代理端点 (兼容 Playwright)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/b/:browserId/json/version` | CDP 版本信息 |
| GET | `/api/v1/b/:browserId/json/list` | CDP target 列表 |
| GET | `/api/v1/b/:browserId/json/protocol` | CDP 协议描述 |
| WS | `/ws/client/:browserId` | CDP WebSocket 连接 |
| WS | `/ws/devtools/browser/:browserId` | Browser 级别 WS |
| WS | `/ws/devtools/page/:targetId` | Page 级别 WS |

### 7.5 Session & 审计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions` | 控制会话历史 |
| GET | `/api/v1/sessions/:id` | 会话详情 |
| GET | `/api/v1/audit-logs` | 操作审计日志 |

### 7.6 WebSocket 消息协议

#### Plugin → Server

```jsonc
// 认证
{ "type": "auth", "apiKey": "ak_live_xxx" }

// 心跳 (复用现有)
{ "type": "keepalive" }

// 版本信息 (复用现有)
{ "type": "plugin-hello", "version": "1.2.0" }

// CDP 事件 (复用现有)
{ "type": "event", "method": "Target.targetCreated", "params": {...} }

// CDP 响应 (复用现有)
{ "id": "global_123", "result": {...} }
```

#### Server → Plugin

```jsonc
// 认证结果 (新增)
{ "type": "auth_result", "success": true, "browserId": "b_xxx", "userId": "u_xxx" }
{ "type": "auth_result", "success": false, "error": "Invalid API Key" }

// 连接确认 (改造现有)
{ "type": "connected", "role": "plugin", "id": "plugin_xxx", "browserId": "b_xxx" }
```

#### Client → Server

```
连接时通过 HTTP Header 或首条消息携带 JWT:
  URL: wss://domain.com/ws/client/:browserId
  Header: Authorization: Bearer eyJ...
  或首条消息: { "type": "auth", "token": "eyJ..." }
```

---

## 8. 部署方案

### 8.1 单服务器进程编排

```
┌──────────────── VPS (2C4G+) ────────────────┐
│                                              │
│  ┌──────────┐  :80/:443                      │
│  │  Nginx   │◀────── Let's Encrypt SSL       │
│  └──┬───┬───┘                                │
│     │   │                                    │
│     │   └──────────────────────┐             │
│     ▼                          ▼             │
│  ┌──────────────┐  ┌──────────────────┐      │
│  │ Node.js      │  │ Node.js          │      │
│  │ API Server   │  │ WS Gateway       │      │
│  │ :3000        │  │ :9221 (内网)     │      │
│  │              │  │                  │      │
│  │ - Express    │  │ - 改造后的       │      │
│  │ - JWT 验证   │  │   proxy-server   │      │
│  │ - 用户管理   │  │ - 多租户隔离     │      │
│  │ - 静态文件   │  │ - CDP 透传       │      │
│  └──────┬───────┘  └────────┬─────────┘      │
│         │                   │                │
│         ▼                   ▼                │
│  ┌────────────────────────────────────┐      │
│  │         SQLite / PostgreSQL        │      │
│  │         (本地文件或同机 Docker)     │      │
│  └────────────────────────────────────┘      │
│                                              │
│  进程管理: PM2 或 systemd                     │
└──────────────────────────────────────────────┘
```

### 8.2 Nginx 配置

```nginx
upstream api_server {
    server 127.0.0.1:3000;
}

upstream ws_gateway {
    server 127.0.0.1:9221;
}

server {
    listen 443 ssl http2;
    server_name cdp.example.com;

    ssl_certificate     /etc/letsencrypt/live/cdp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cdp.example.com/privkey.pem;

    # API & 静态文件
    location /api/ {
        proxy_pass http://api_server;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /app/ {
        proxy_pass http://api_server;
        proxy_set_header Host $host;
    }

    # WebSocket - Plugin 连接
    location /ws/plugin {
        proxy_pass http://ws_gateway;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;    # 1h 长连接超时
        proxy_send_timeout 3600s;
    }

    # WebSocket - Client 连接
    location /ws/client/ {
        proxy_pass http://ws_gateway;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # WebSocket - DevTools
    location /ws/devtools/ {
        proxy_pass http://ws_gateway;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # HTTP CDP 端点
    location /api/v1/b/ {
        proxy_pass http://ws_gateway;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 8.3 PM2 配置

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'cdp-api',
      script: 'server/api-server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        DATABASE_URL: 'sqlite:./data/cdp-tunnel.db',
        JWT_SECRET: 'xxx'
      }
    },
    {
      name: 'cdp-ws',
      script: 'server/ws-gateway.js',
      env: {
        NODE_ENV: 'production',
        PORT: 9221,
        DATABASE_URL: 'sqlite:./data/cdp-tunnel.db',
        JWT_SECRET: 'xxx'
      }
    }
  ]
};
```

### 8.4 存储方案

| 方案 | 适用场景 | 说明 |
|------|---------|------|
| **SQLite** (推荐起步) | < 100 用户 | 零运维，文件备份，足够支撑 |
| PostgreSQL | > 100 用户 或需要并发写入 | 更好的并发和查询能力 |
| Redis (可选) | 高频心跳/在线状态缓存 | 减少数据库写入频率 |

SQLite 性能参考: 单机 100 用户 × 每人 1-3 个浏览器 = 300 个 WebSocket 连接，心跳和状态更新对 SQLite 写入压力很小 (每 30s 一次心跳，批量 UPDATE)。

---

## 9. 安全性

### 9.1 WebSocket 鉴权

```
Plugin 连接鉴权:
  1. Plugin 连接 WS 后，必须在 5s 内发送 auth 消息
  2. 超时未认证 → close(4001, 'Auth timeout')
  3. API Key 验证失败 → close(4003, 'Invalid API Key')
  4. 已吊销的 Key → close(4003, 'Key revoked')

Client 连接鉴权:
  1. Upgrade 请求携带 JWT (Header 或 Query 参数)
  2. 验证 JWT 签名和有效期
  3. 从 JWT 中提取 userId
  4. 检查该 userId 是否拥有请求的 browserId
  5. 不属于 → close(4003, 'Forbidden')
```

### 9.2 多租户隔离保障

```javascript
// 每个 CDP 消息路由前都做租户校验
function routeCDPMessage(ws, data, namespace) {
    // 1. ws.userId 必须等于 namespace.userId
    if (ws.userId !== namespace.userId) {
        console.error(`[SECURITY] Cross-tenant access blocked: ${ws.userId} → ${namespace.userId}`);
        ws.close(4003, 'Forbidden');
        return;
    }

    // 2. Client 只能连自己名下的 browser
    if (ws.browserId && !namespace.browsers.has(ws.browserId)) {
        ws.close(4003, 'Browser not found');
        return;
    }

    // 3. 消息路由在 namespace 内部进行
    // ... 原有路由逻辑
}
```

### 9.3 操作审计

```javascript
// 审计的关键操作
const AUDITED_CDP_METHODS = [
    'Runtime.evaluate',        // 代码执行
    'Page.navigate',           // 页面导航
    'Network.enable',          // 网络监控
    'Input.dispatchMouseEvent', // 鼠标操作
    'Input.dispatchKeyEvent',  // 键盘操作
    'DOM.setAttributeValue',   // DOM 修改
];

// 在 Client → Plugin 消息处理中记录
function auditCDPCommand(userId, browserId, method, params) {
    if (AUDITED_CDP_METHODS.includes(method)) {
        db.insertAuditLog({
            userId,
            action: `cdp.${method}`,
            resourceType: 'browser',
            resourceId: browserId,
            detail: JSON.stringify({ method, paramsPreview: JSON.stringify(params).substring(0, 200) }),
        });
    }
}
```

### 9.4 频率限制

```
层级 1: Nginx 层 IP 级限流
  - limit_req_zone $binary_remote_addr zone=ws:10m rate=10r/m;
  - 防止暴力连接

层级 2: API 层路由限流
  - 登录: 5 次/分钟/IP
  - API Key 创建: 10 次/小时/用户
  - 其他 API: 100 次/分钟/用户

层级 3: WebSocket 消息限流
  - Plugin: 不限制 (CDP 消息量大)
  - Client: 1000 条/秒 (正常 CDP 交互足够)
  - 超限: 发送 { type: "rate_limit", retryAfter: 1 } 暂不断连
```

### 9.5 API Key 安全存储

```
生成:
  1. randomBytes(24).toString('hex') → 原始 key (仅展示一次)
  2. key_prefix = key.substring(0, 12)  → 存储前缀用于识别
  3. key_hash = sha256(key)             → 存储哈希用于验证

验证:
  1. 客户端发送 apiKey
  2. server: sha256(apiKey) 查询 api_keys 表
  3. 匹配 → 通过; 不匹配 → 拒绝

注意: 数据库中不存储原始 key，丢失无法找回只能重新生成
```

### 9.6 其他安全措施

- **TLS 强制**: 所有连接必须通过 HTTPS/WSS
- **CORS**: API 只允许指定域名访问
- **Content-Security-Policy**: 管理界面 CSP 头
- **WebSocket Origin 校验**: 拒绝非预期来源
- **定期清理**: 离线浏览器 > 30 天未上线自动归档
- **会话超时**: JWT 24h 过期，可配置 refresh

---

## 10. 文件结构

```
cdp-tunnel2/
├── server/
│   ├── api-server.js              # [新增] API 服务器入口
│   ├── ws-gateway.js              # [改造] 由 proxy-server.js 重命名
│   ├── modules/
│   │   ├── config.js              # [保留] 配置模块
│   │   ├── logger.js              # [保留] 日志模块
│   │   ├── auth.js                # [新增] JWT + API Key 验证
│   │   ├── tenant-manager.js      # [新增] 多租户命名空间管理
│   │   ├── database.js            # [新增] 数据库连接 & 迁移
│   │   ├── rate-limiter.js        # [新增] 频率限制
│   │   └── audit.js               # [新增] 审计日志记录
│   ├── routes/
│   │   ├── auth.js                # [新增] /api/v1/auth/*
│   │   ├── browsers.js            # [新增] /api/v1/browsers/*
│   │   ├── api-keys.js            # [新增] /api/v1/api-keys/*
│   │   ├── sessions.js            # [新增] /api/v1/sessions/*
│   │   └── audit-logs.js          # [新增] /api/v1/audit-logs/*
│   ├── middleware/
│   │   ├── auth-middleware.js     # [新增] JWT 认证中间件
│   │   └── error-handler.js      # [新增] 统一错误处理
│   └── db/
│       ├── schema.sql             # [新增] DDL 建表语句
│       └── migrations/            # [新增] 数据库迁移脚本
├── web/                           # [新增] React 前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx               # 入口
│   │   ├── App.tsx                # 路由配置
│   │   ├── api/                   # API 客户端
│   │   │   ├── client.ts          # fetch 封装 + JWT 注入
│   │   │   ├── auth.ts            # 认证 API
│   │   │   ├── browsers.ts        # 浏览器 API
│   │   │   └── api-keys.ts        # API Key 管理
│   │   ├── stores/                # Zustand stores
│   │   │   ├── auth.ts
│   │   │   └── browsers.ts
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   ├── Dashboard.tsx
│   │   │   ├── BrowserList.tsx
│   │   │   ├── BrowserDetail.tsx
│   │   │   ├── RemoteControl.tsx  # 远程控制界面
│   │   │   ├── ApiKeys.tsx
│   │   │   ├── Settings.tsx
│   │   │   └── AuditLog.tsx
│   │   ├── components/
│   │   │   ├── Layout.tsx
│   │   │   ├── BrowserCard.tsx
│   │   │   ├── StatusBadge.tsx
│   │   │   ├── ApiKeyForm.tsx
│   │   │   └── DevToolsPanel.tsx  # 远程 DevTools 组件
│   │   └── utils/
│   │       ├── ws.ts              # WebSocket 客户端封装
│   │       └── format.ts          # 格式化工具
│   └── public/
├── extension-new/                 # [改造] Chrome 扩展
│   ├── core/
│   │   ├── websocket.js           # [改造] 添加 API Key 认证
│   │   ├── debugger.js            # [保留]
│   │   ├── state.js               # [保留]
│   │   └── config.js              # [改造] 支持 API Key 配置
│   ├── popup/
│   │   └── popup.html/js          # [改造] 添加 API Key 配置 UI
│   └── ...
├── shared/                        # [新增] 共享类型/常量
│   ├── types.ts                   # TypeScript 类型定义
│   └── constants.js               # 共享常量
├── data/                          # [新增] 运行时数据
│   └── cdp-tunnel.db              # SQLite 数据库文件
├── docs/
│   └── plans/
│       └── 2026-05-18-saas-architecture.md  # 本文档
├── nginx/
│   └── cdp-tunnel.conf            # [新增] Nginx 配置
├── scripts/
│   ├── setup.sh                   # [新增] 一键部署脚本
│   └── migrate.js                 # [新增] 数据库迁移
├── ecosystem.config.js            # [新增] PM2 配置
├── package.json
└── README.md
```

### 文件分类说明

| 标记 | 数量 | 说明 |
|------|------|------|
| [保留] | 3 | config.js, logger.js, debugger.js 无需改动 |
| [改造] | 4 | proxy-server.js→ws-gateway.js, websocket.js, config.js, popup |
| [新增] | ~25 | API Server, React 前端, 数据库, 中间件, 部署配置 |

---

## 附录 A: 改造优先级与里程碑

### Phase 1: 最小可用 (1-2 周)
- [ ] TenantNamespace + TenantManager
- [ ] proxy-server.js → ws-gateway.js 改造
- [ ] API Key 认证 (插件端)
- [ ] SQLite 数据库 + schema
- [ ] 基础 API (auth, browsers CRUD)
- [ ] 最简 Web 界面 (登录 + 浏览器列表)

### Phase 2: 管理平台 (1 周)
- [ ] React SPA 完整页面
- [ ] API Key 管理 UI
- [ ] 远程控制界面 (DevTools 嵌入)
- [ ] 审计日志

### Phase 3: 安全加固 (3-5 天)
- [ ] Nginx + TLS
- [ ] 频率限制
- [ ] 操作审计完善
- [ ] CDP 消息审计

### Phase 4: 生产就绪 (3-5 天)
- [ ] PM2 部署脚本
- [ ] 监控告警 (健康检查)
- [ ] 备份策略
- [ ] 压力测试 (100 并发浏览器)

---

## 附录 B: 性能估算

### 资源消耗 (单服务器 100 浏览器)

| 资源 | 估算 | 说明 |
|------|------|------|
| WebSocket 连接 | ~300 个 | 100 plugins + 100 clients + 100 page |
| 内存 | ~500MB | Node.js ~200MB + SQLite + 缓存 |
| CPU | 低 | CDP 消息透传为主，计算量小 |
| 网络 | 取决于 CDP 操作 | 截图/视频流最大消耗 |
| 磁盘 I/O | 极低 | 心跳更新 + 审计日志写入 |

### 瓶颈分析

| 瓶颈 | 阈值 | 缓解方案 |
|------|------|---------|
| 单进程 WebSocket 连接数 | ~10K | 足够支撑 100 浏览器 |
| SQLite 并发写入 | ~100 TPS | 批量写入 + WAL 模式 |
| 内存 | Node.js 默认 1.7GB | 超过 500 浏览器考虑 Redis |

**结论**: 2C4G VPS 足够支撑 100 个同时在线浏览器，无需水平扩展。
