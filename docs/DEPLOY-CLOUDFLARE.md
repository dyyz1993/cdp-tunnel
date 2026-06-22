# 远程部署指南（Cloudflare Tunnel + API Key 鉴权）

本文档介绍如何把 cdp-tunnel proxy 通过 Cloudflare Tunnel 暴露到公网，实现远程控制浏览器。

## 架构

```
远程 CDP 客户端 ──wss──▶ Cloudflare 边缘 ──▶ cloudflared（本地）──▶ 本地 proxy（9221）──▶ 本地 Chrome+扩展
                                                │
                          扩展连 ws://localhost:9221/plugin?key=xxx
```

**特点：**
- proxy 仍然跑在本地（Chrome 也在本地）
- Cloudflare Tunnel 把本地端口暴露成公网域名（免费、无需 VPS、自带 TLS）
- API Key 鉴权：一个 key = 一个浏览器，不同 key 互不可见

## 前置条件

1. 本地已装好 cdp-tunnel（`npm install -g cdp-tunnel` 或本项目）
2. Chrome 已装好 cdp-tunnel 扩展
3. 已安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

```bash
# macOS
brew install cloudflared
```

## 步骤

### 1. 启动 proxy（开启鉴权）

```bash
# 必须 REQUIRE_AUTH=true，否则任何人都能控制你的浏览器
REQUIRE_AUTH=true node server/proxy-server.js
```

确认日志出现：
```
[CREATE PORT 0] Main port 9221 (reuses main server)
[PORT POOL] Started: takeover=9220, create=9221(main) + 9231-9239
```

### 2. 创建 API Key

```bash
node server/saas/key-manager.js create 我的浏览器
```

输出（示例）：
```
✅ Key 创建成功

  Key:       cdp_a1b2c3d4e5f6...
  扩展连接地址（填进扩展配置页）:
  ws://localhost:9221/plugin?key=cdp_a1b2c3d4e5f6...
  CDP 客户端连接地址:
  ws://localhost:9221/client?key=cdp_a1b2c3d4e5f6...
```

**记下这个 key**（`cdp_` 开头的那串），后面要用。

> 管理 key：`node server/saas/key-manager.js list` 列出 / `revoke <keyId>` 吊销

### 3. 配置扩展连本地 proxy

1. 打开扩展配置页（chrome://extensions → cdp-tunnel → 配置）
2. 添加连接，地址填**带 key 的本地地址**：
   ```
   ws://localhost:9221/plugin?key=cdp_a1b2c3d4e5f6...
   ```
3. 启用连接，确认状态变绿（已连接）

### 4. 启动 Cloudflare Tunnel

**快速试用（临时域名）：**
```bash
cloudflared tunnel --url http://localhost:9221
```

输出会给你一个临时公网域名：
```
https://xxx-yyy-zzz.trycloudflare.com
```

**长期使用（固定域名）：**
```bash
# 首次登录（浏览器授权）
cloudflared tunnel login

# 创建隧道
cloudflared tunnel create cdp-tunnel

# 配置路由（把你的域名指向本地 9221）
cloudflared tunnel route dns cdp-tunnel cdp.你的域名.com

# 启动
cloudflared tunnel run cdp-tunnel
```

详见 [Cloudflare Tunnel 官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)。

### 5. 远程客户端连接

远程的 CDP 客户端（Playwright/Puppeteer/任意 CDP SDK）用**带 key 的公网地址**连接：

```javascript
// Playwright 示例
const browser = await chromium.connectOverCDP(
  'wss://cdp.你的域名.com/client?key=cdp_a1b2c3d4e5f6...'
);
```

```bash
# Puppeteer 示例
puppeteer.connect({ browserWSEndpoint: 'wss://cdp.你的域名.com/client?key=cdp_a1b2c3d4e5f6...' })
```

**注意：** 公网地址用 `wss://`（加密），不是 `ws://`。

## 验证

远程连接后，本地 proxy 日志会出现：
```
[PLUGIN AUTHED] userId=builtin-admin keyName=我的浏览器
```

扩展配置页显示 🔑 标识（带 API Key 鉴权）。

## 安全须知

| 规则 | 说明 |
|------|------|
| **必须 REQUIRE_AUTH=true** | 不开鉴权 = 任何人都能控制你的浏览器 |
| **key 不要泄露** | key 等同于浏览器控制权，截图/分享时注意遮挡（配置页已自动隐藏 key 明文） |
| **用 wss:// 不用 ws://** | Cloudflare 自动提供 TLS，客户端必须用 wss |
| **定期吊销旧 key** | `node server/saas/key-manager.js revoke <keyId>` |

## 多浏览器场景

每个浏览器一个 key：

```bash
node server/saas/key-manager.js create 浏览器1   # 给电脑 A
node server/saas/key-manager.js create 浏览器2   # 给电脑 B
```

不同 key 的浏览器互不可见（端口池隔离 + key 路由）。

> **注意：** 当前版本多浏览器共享同一个 proxy 端口（9221）。如果要完全独立的隔离环境，用端口池端口：`ws://localhost:9231/plugin?key=xxx`（每个端口一个独立分组）。多 key 共享同端口的多租户成熟期支持待后续优化。

## 故障排查

**扩展连不上：**
- 确认 `REQUIRE_AUTH=true` 已设置
- 确认 key 正确：`node server/saas/key-manager.js list`
- 看扩展配置页状态是否变绿

**远程客户端连不上：**
- 确认 cloudflared 在跑（`cloudflared tunnel info cdp-tunnel`）
- 确认用 `wss://` 不是 `ws://`
- 确认 key 带在 URL 里：`?key=cdp_xxx`

**better-sqlite3 报错（NODE_MODULE_VERSION 不匹配）：**
```bash
npm rebuild better-sqlite3
```
