# 多浏览器实例服务

把 cdp-tunnel 包装成一个"中转站"服务：一台服务器同时管理多个远程浏览器，每个浏览器用独立的 API Key 标识，互不可见。

## 简介

典型场景：

```
服务方（你）                              用户A / 用户B / ...
─────────────                            ──────────────
┌─────────────────────────┐              ┌──────────────┐
│  cdp-tunnel proxy       │◀──wss───扩展 │  用户A 浏览器  │
│  (公网 wss://...)       │◀──wss───扩展 │  用户B 浏览器  │
│  + key 鉴权             │              └──────────────┘
│  + 按 key 隔离           │
└─────────┬───────────────┘
          │
          ▼ Playwright/CDP connectOverCDP
     服务方用 clientUrl 接管浏览器
```

- 一 key = 一浏览器实例（不同 key 的浏览器互不可见）
- 标准协议：客户端用 Playwright `connectOverCDP` 即可，无需学新 API
- 服务端发现：`/json/browsers` 列出所有在线浏览器
- 容错：某个浏览器断开，只影响对应 key，其他 key 不受影响

## 前置条件

```bash
# 1. 安装 cdp-tunnel
npm install -g cdp-tunnel

# 2. 准备 Chromium（macOS 默认路径 /Applications/Chromium.app）
#    或通过 CHROME_PATH 环境变量指定

# 3. 进入项目目录（开发模式下）
cd cdp-tunnel2
```

## 快速开始

直接运行示例脚本，会自动完成全部流程：

```bash
NO_PROXY=localhost,127.0.0.1,::1 node examples/multi-browser-service.js
```

预期输出：

```
=== 多浏览器实例服务示例 ===

[SERVICE] 启动 cdp-tunnel proxy on port 29xxx...
[SERVICE] Proxy 就绪
[SERVICE] 用户A 的 Key: cdp_xxxx...
[SERVICE] 用户B 的 Key: cdp_xxxx...
[BROWSER] 启动用户A 的 Chrome...
[BROWSER] 启动用户B 的 Chrome...
[SERVICE] 发现 2 个在线浏览器
[CDP] 用户A 的浏览器打开百度...
[CDP] 用户A 百度 title: "百度一下，你就知道"
[CDP] 用户B 的浏览器打开 example.com...
[CDP] 用户B example.com title: "Example Domain"
[VERIFY] 用户A 看到的页面: ["https://www.baidu.com/"]
[VERIFY] 用户B 看到的页面: ["https://example.com/"]

=== 结果 ===
  用户A 打开百度:    ✅ (百度一下，你就知道)
  用户B 打开 example: ✅ (Example Domain)
  A 看不到 B 的页面:  ✅
  B 看不到 A 的页面:  ✅
```

## 流程说明

示例脚本 [examples/multi-browser-service.js](multi-browser-service.js) 完整演示了以下 7 步：

### Step 1 — 启动 proxy（强制鉴权）

```javascript
const { spawn } = require('child_process');
const PROXY_PATH = require.resolve('cdp-tunnel/server/proxy-server.js');

const proxyProc = spawn('node', [PROXY_PATH], {
  env: {
    ...process.env,
    PORT: String(PORT),
    REQUIRE_AUTH: 'true',        // 强制 key 鉴权
    POOL_SIZE: '3',              // 端口池隔离
    LOG_LEVEL: 'warn'
  }
});
```

### Step 2 — 为每个用户创建 API Key

```bash
node server/saas/key-manager.js create 用户A
# 输出：
#   Key: cdp_aaaa1111...
#   扩展连接地址: ws://your-server:PORT/plugin?key=cdp_aaaa1111...
#   CDP 客户端地址: ws://your-server:PORT/client?key=cdp_aaaa1111...
```

**一 key = 一浏览器实例槽位**。创建后把 pluginUrl 给用户填进扩展。

### Step 3 — 用户装扩展 + 配置 key

用户在自己电脑上：
1. `chrome://extensions/` → 开发者模式 → 加载 `extension-new/` 目录
2. 点扩展图标 → 配置页 → 添加连接 → 填入服务方给的 pluginUrl
3. 点"连接"——扩展通过 wss 连上服务方的 proxy

### Step 4 — 服务端发现浏览器

```javascript
const browsers = await httpGet(PORT, '/json/browsers');
// 返回所有在线浏览器列表
```

### Step 5 — 用 CDP 接管浏览器

```javascript
// 标准 Playwright 接入
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP(
  `ws://your-server:${PORT}/client?key=${KEY_A}`
);
```

或用裸 CDP WebSocket（示例脚本采用的方式）：

```javascript
const WebSocket = require('ws');
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/client?key=${KEY_A}`);
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
});
```

### Step 6 — 分别操作各浏览器

```javascript
// 用户A 打开百度
const { sessionId: sessA } = await createPageAndNavigate(clientA, 'https://www.baidu.com');
const titleA = await clientA.send('Runtime.evaluate', { expression: 'document.title' }, sessA);

// 用户B 打开 example.com
const { sessionId: sessB } = await createPageAndNavigate(clientB, 'https://example.com');
const titleB = await clientB.send('Runtime.evaluate', { expression: 'document.title' }, sessB);
```

### Step 7 — 验证隔离

```javascript
const tgA = await clientA.send('Target.getTargets');
const tgB = await clientB.send('Target.getTargets');
// keyA 只看到自己创建的百度，看不到 example.com
// keyB 只看到自己创建的 example.com，看不到百度
```

## 验证点（测试覆盖）

自动化测试 [tests/e2e/test-multi-browser.js](../tests/e2e/test-multi-browser.js) 覆盖以下 11 个检查点，每个都是可断言的硬性指标：

| # | 检查点 | 说明 |
|---|---|---|
| 1 | 服务端发现 2 个浏览器 | `/json/browsers` 返回数组长度 ≥ 2 |
| 2 | keyA 打开百度 | createTarget + navigate + get title 非空 |
| 3 | keyB 打开 example.com | 同上 |
| 4 | keyA 看到自己打开的百度 | `Target.getTargets` 包含 baidu URL |
| 5 | keyA 看不到 keyB 的 example.com | `Target.getTargets` 不包含 example.com |
| 6 | keyB 看到自己打开的 example.com | `Target.getTargets` 包含 example.com URL |
| 7 | keyB 看不到 keyA 的百度 | `Target.getTargets` 不包含 baidu |
| 8 | 并发操作：keyA 得到 MARK-A | Promise.all 并发注入，结果正确 |
| 9 | 并发操作：keyB 得到 MARK-B | 同上 |
| 10 | ChromeA 断开后 keyA 被拒 | 新 client 连 `/client?key=KEY_A` 被 close |
| 11 | ChromeA 断开后 keyB 不受影响 | keyB 仍能 createTarget + evaluate |

## 发版前必跑

**每次发版前必须跑一遍，确保多浏览器场景未被破坏。**

```bash
# 单独跑多浏览器测试
NO_PROXY=localhost,127.0.0.1,::1 node tests/e2e/test-multi-browser.js

# 期望结果：11 passed, 0 failed
```

该测试已纳入 `run-all.js` 的 core tier：

```bash
# 跑 core 测试套件（包含本测试）
SKIP_EXTENDED=1 npm run test:e2e
```

## 关键设计

### 为什么用独立扩展副本

两个 Chrome 不能共享同一个 `extension-new/` 目录，因为每个扩展的 `config.js` 要注入不同的 key。示例采用的方式是：

```javascript
// 复制扩展到临时目录
fs.cpSync(EXTENSION_PATH, tmpExt, { recursive: true });
// 改 config.js 注入 key
fs.writeFileSync(configPath, configOriginal.replace(
  /WS_URL:\s*'[^']*'/,
  `WS_URL: 'ws://127.0.0.1:${port}/plugin?key=${key}'`
));
// 启动 Chrome 加载这个副本
spawn(CHROME_PATH, [`--load-extension=${tmpExt}`, ...]);
```

### 为什么用 127.0.0.1 而不是 localhost

Node.js 25+ 在 macOS 上 `localhost` 会优先解析到 IPv6（`::1`），而 proxy 监听的是 `0.0.0.0`。虽然 `0.0.0.0` 理论上同时覆盖 IPv4/IPv6，但 IPv6 的连接在某些环境下不稳定。统一用 `127.0.0.1` 避免歧义。

### 为什么用 CDP WebSocket 而不是 Playwright

示例脚本用裸 CDP WebSocket（`ws` 库）而不是 Playwright `connectOverCDP`，因为：
- 更底层、更可控、不依赖 Playwright 版本
- 测试更稳定（Playwright 的 `contexts()` 在 connectOverCDP 场景下行为不一致）

实际生产中用 Playwright `connectOverCDP(clientUrl)` 完全可以，参考 [test-default-page.js](../tests/e2e/test-default-page.js) 的用法。

## 相关文件

- [examples/multi-browser-service.js](multi-browser-service.js) — 可直接运行的示例
- [tests/e2e/test-multi-browser.js](../tests/e2e/test-multi-browser.js) — 自动化测试（11 checks）
- [server/saas/key-manager.js](../server/saas/key-manager.js) — Key 管理 CLI
- [docs/DEPLOY-CLOUDFLARE.md](../docs/DEPLOY-CLOUDFLARE.md) — 公网部署指南
- [index.js](../index.js) — SDK 入口（`require('cdp-tunnel')`）
