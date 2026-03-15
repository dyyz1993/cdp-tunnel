# CDP Tunnel

<p align="center">
  <img src="../extension-new/icons/icon128.png" alt="CDP Tunnel Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Chrome DevTools Protocol 桥接器</strong>
</p>

<p align="center">
  Chrome 扩展，将浏览器暴露为 CDP 端点，<br>
  支持多个 Playwright/Puppeteer 客户端同时连接和控制。
</p>

<p align="center">
  <a href="../README.md">English</a> | 
  <a href="https://github.com/dyyz1993/cdp-tunnel">GitHub</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/dyyz1993/cdp-tunnel?style=social" alt="GitHub stars">
  <img src="https://img.shields.io/github/forks/dyyz1993/cdp-tunnel?style=social" alt="GitHub forks">
  <img src="https://img.shields.io/github/watchers/dyyz1993/cdp-tunnel?style=social" alt="GitHub watchers">
</p>

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        代理服务器                                │
│                     (localhost:9222)                            │
│                                                                 │
│   /plugin  ←─── Chrome 扩展 (WebSocket)                         │
│   HTTP     ←─── Playwright/Puppeteer 客户端                     │
└─────────────────────────────────────────────────────────────────┘
         ↑              ↑              ↑
         │              │              │
    Client 1       Client 2       Client 3
   (clientId_1)    (clientId_2)    (clientId_3)
```

## 功能特性

- **多客户端支持** - 多个 Playwright/Puppeteer 可同时连接
- **消息隔离** - 每个客户端创建的页面归该客户端所有
- **配置页面** - 可视化查看连接状态、客户端列表、受控页面
- **自动重连** - 扩展断开后自动重连服务器

## 截图

![配置页面](config-page-screenshot.png)

## 快速开始

### 1. 启动代理服务器

```bash
cd server
npm install
node proxy-server.js
```

服务器将在 `localhost:9222` 启动。

### 2. 安装 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension-new` 目录

### 3. 连接扩展

点击扩展图标，在配置页面输入服务器地址，点击「保存并连接」。

### 4. 客户端连接

```javascript
// Playwright
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto('https://example.com');

// Puppeteer
const puppeteer = require('puppeteer');

const browser = await puppeteer.connect({
  browserWSEndpoint: 'ws://localhost:9222'
});
const page = await browser.newPage();
await page.goto('https://example.com');
```

## 多客户端使用

所有客户端连接同一个端点 `http://localhost:9222`，服务器自动为每个连接分配唯一的 `clientId`。

```javascript
// 多个客户端可以同时连接
const browser1 = await chromium.connectOverCDP('http://localhost:9222');
const browser2 = await chromium.connectOverCDP('http://localhost:9222');
const browser3 = await chromium.connectOverCDP('http://localhost:9222');

// 每个客户端创建的页面互不干扰
const page1 = await browser1.contexts()[0].newPage();
const page2 = await browser2.contexts()[0].newPage();
const page3 = await browser3.contexts()[0].newPage();
```

## 配置页面

点击扩展图标打开配置页面，可以查看：

- **CDP 客户端列表** - 显示连接的 Playwright/Puppeteer 客户端
- **受控页面列表** - 显示被控制的页面，支持点击跳转
- **活动日志** - 连接状态变化记录

## 项目结构

```
cdp-tunnel/
├── server/
│   └── proxy-server.js      # 代理服务器
├── extension-new/
│   ├── background.js        # 扩展 Service Worker
│   ├── config-page-preview.html  # 配置页面
│   ├── config-page.js       # 配置页面脚本
│   ├── core/
│   │   ├── state.js         # 状态管理
│   │   └── websocket.js     # WebSocket 连接管理
│   └── features/
│       ├── cdp-router.js    # CDP 消息路由
│       └── screencast.js    # 截图功能
└── tests/
    ├── playwright-single.js      # 单客户端测试
    ├── playwright-multi.js       # 多客户端测试
    └── playwright-interactive.js # 交互式测试
```

## 测试

```bash
# 单客户端测试
node tests/playwright-single.js

# 多客户端测试
node tests/playwright-multi.js

# 交互式测试
node tests/playwright-interactive.js
```

## 注意事项

1. **端口占用** - 确保 9222 端口未被占用
2. **扩展权限** - 扩展需要 `debugger`、`tabs` 等权限
3. **浏览器限制** - 同一浏览器只能被一个扩展通过 debugger 控制

## 许可证

本项目采用 Apache License 2.0 协议，并附加署名要求。

详见 [LICENSE](../LICENSE)。

---

如果你在工作中使用了本项目，请注明来源：
- 项目：CDP Tunnel
- 作者：dyyz1993
- 来源：https://github.com/dyyz1993/cdp-tunnel
