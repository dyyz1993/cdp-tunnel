# AGENTS.md - CDP Tunnel 项目开发原则与规范

## 核心原则

### 0. 必须模拟原生 Chrome CDP 协议行为（基础原则）

**cdp-tunnel 的目标是让标准 CDP 客户端（Playwright/Puppeteer/CDP SDK）无感接入。**

所有 CDP 命令的响应和事件必须与原生 Chrome（`--remote-debugging-port`）保持一致：

- **命令响应**：字段名、类型、默认值必须与 Chrome DevTools Protocol 规范一致。例如 `Target.getTargetInfo` 返回的 `targetInfo.url` 必须存在（至少 `"about:blank"`），不能是 `undefined` 或缺失。
- **事件流**：事件的顺序和内容必须与原生 Chrome 一致。例如 `Page.navigate` 成功后，`Page.frameNavigated` 事件不应回退到 `about:blank`。
- **行为差异**：如果 cdp-tunnel 的行为与原生 Chrome 不同，以原生 Chrome 为准。发现差异时应修复 cdp-tunnel，而不是让客户端做 workaround。

**任何代码改动都不得引入与原生 Chrome CDP 不一致的行为。** 如果改动可能导致协议行为偏离原生 Chrome，该改动不可合并。

### 1. 用户标签不可侵犯（最高优先级）

**CDP 自动化标签绝对不允许侵占用户的正常标签。**

- **9221 端口（创建模式 / create）**：所有通过 CDP 创建的标签必须被强制分组到独立的 Chrome Tab Group 中，与用户的正常标签严格隔离。分组必须可见、可折叠，让用户一眼区分哪些是自动化标签。
- **9222 端口（接管模式 / takeover）**：允许 CDP 客户端接管用户已打开的标签。此模式下不创建分组，因为操作的就是用户自己的标签。

**任何代码改动都不得违反此原则。** 如果改动可能导致标签逃逸分组或与用户标签混合，该改动不可合并。

### 2. 开发测试端口隔离

**开发者在开发和测试时，必须使用独立端口，绝不允许占用用户的 9221/9222 端口。**

- 用户端口：`9221`（创建模式）、`9222`（接管模式）
- 开发测试端口：使用环境变量 `PORT` 指定，推荐使用 `9231`/`9232` 或其他非用户端口
- 启动方式：`PORT=9231 node server/proxy-server.js`
- 扩展连接：测试时修改 `extension-new/utils/config.js` 的 `WS_URL` 指向测试端口
- 测试完成后**必须恢复** `config.js` 的 `WS_URL` 为用户端口

### 3. 自动化测试端口分配

E2E 测试和开发脚本应自动分配端口，流程如下：

```bash
# 自动选择可用端口（不要硬编码 9221/9222）
PORT=9231 TAKEOVER_PORT=9232 node server/proxy-server.js
```

测试框架应在启动时检查端口可用性，避免与用户正在运行的服务冲突。

### 4. 分组 = 浏览器实例（分组不可侵犯）

**分组（Chrome Tab Group）等价于一个浏览器实例。分组存在 = 浏览器存在，分组消失 = 浏览器不存在。** 这是最高优先级架构原则，任何改动不得违反。

#### create 模式（端口池 / 9221 / 9231-9239）

```
┌──────────────────────────────────────────────────┐
│  Chrome Tab Group = 一个独立的浏览器实例               │
│  分组一直存在，直至有人明确要求销毁它                      │
│                                                    │
│  Client 断开（WebSocket close）→ 分组存活、tab 存活    │
│  → 只清理 server 端内存（pendingRequests, sessionMap）  │
│  → 不发送 client-disconnected 到扩展                   │
│  → 扩展不知道 client 已断开，分组和 tab 纹丝不动           │
│                                                    │
│  Browser.close CDP 命令 → No-op（纯空返回）            │
│  → 扩展 LocalHandler.browserClose 返回 {}             │
│  → 不关分组、不关 tab、不 detach                       │
│                                                    │
│  Target.closeTarget → 只关闭指定 tab，不关分组          │
│  分组保留，其他 tab 不受影响                             │
└──────────────────────────────────────────────────┘
```

**实现代码路径**：
- 连接处理：[port-pool.js `_handleClientConnect`](file:///Users/xuyingzhou/Project/study-web/cdp-tunnel2/server/modules/port-pool.js#L226)
- 断开处理：[port-pool.js `ws.on('close')`](file:///Users/xuyingzhou/Project/study-web/cdp-tunnel2/server/modules/port-pool.js#L325)（只清内存，不通知扩展）
- Browser.close：[local.js `browserClose`](file:///Users/xuyingzhou/Project/study-web/cdp-tunnel2/extension-new/cdp/handler/local.js#L30)（返回空结果）

#### takeover 模式（9222 / 9220）

```
┌──────────────────────────────────────────────────┐
│  没有分组概念。直接接管用户已打开的 tab，不建分组。         │
│                                                    │
│  Client 断开 → 只 detach debugger，不关 tab           │
│  → 发 takeover-disconnect 到扩展                     │
│  → 扩展只 chrome.debugger.detach，不 chrome.tabs.remove │
│                                                    │
│  Browser.close → 发 takeover-disconnect（同上）       │
│  → 只 detach，不关任何东西                             │
└──────────────────────────────────────────────────┘
```

**实现代码路径**：
- 连接处理：[proxy-server.js `handleClientConnection`](file:///Users/xuyingzhou/Project/study-web/cdp-tunnel2/server/proxy-server.js#L1505)
- 断开处理：[proxy-server.js `cleanupClient`](file:///Users/xuyingzhou/Project/study-web/cdp-tunnel2/server/proxy-server.js#L795)（发 takeover-disconnect）

#### 为什么这很重要

**这是 cdp-tunnel 和原生 Chrome `--remote-debugging-port` 的核心对齐点**：

- 原生 Chrome CDP：client 连上后断开，页面还在，浏览器还在
- cdp-tunnel create 模式：client 连上后断开，分组（=浏览器）还在，tab 还在
- 原生 Chrome CDP：`Browser.close` 无意义（client 无权关浏览器）
- cdp-tunnel create 模式：`Browser.close` 返回空结果，不关任何东西

**任何让分组在 client 断连时自动销毁的改动，均不可合并。**

#### 判断分组是否正确的自查方法

部署后观察 Chrome 窗口：
```
1. 连上 CDP → 看到一个 CDP-xxx 分组出现
2. Playwright/Puppeteer 脚本结束/断开 → 分组仍在（里面有 tab）
3. 再连同一个端口 → 复用旧分组，tab 还在
4. 只有 chrome://extensions/ reload 扩展 → 分组消失（扩展 SW 重启清空 state）
```

如果步骤 2 中分组消失，说明代码有 bug，违反了本条原则。

---

## 合成输入事件与 visibility 约束（v2.10.13+）

### 背景

Chrome 的合成事件路由（synthetic event routing）对页面 `visibilityState` 有硬性要求。cdp-tunnel 的隔离 tab 受此影响，此章节记录所有相关约束。

### 根本约束：chrome.debugger attach 的非 active tab → visibilityState=hidden

cdp-tunnel 用 `chrome.debugger.attach` 连接隔离 tab。**被 chrome.debugger attach 的 tab，只要不是其窗口的 active tab，`document.visibilityState` 会被 Chrome 强制设为 `"hidden"`。** 这是 Chrome 对"被扩展调试的后台 tab"的节流行为，与窗口大小、位置、是否独立窗口**无关**。

已验证无效的替代方案（均不能让 visibility 变 visible）：

- `Page.setWebLifecycleState({state:'active'})` —— ❌ 无效
- `Emulation.setEmulatedMedia({features:[{name:'visibility',value:'visible'}]})` —— ❌ 无效
- `Target.activateTarget` —— ❌ 无效
- 独立窗口（`chrome.windows.create`）+ 缩小/屏幕外/不 focused —— ❌ 无效（chrome.debugger attach 后仍 hidden）
- 展开折叠分组但不激活 tab —— ❌ 无效

**唯一有效的方式：`Page.bringToFront`**（让 tab 变 active，visibility 从 hidden→visible）。代价是 tab 会切到前台，短暂抢用户焦点。

### 各 CDP 命令在 hidden 状态下的表现

| 命令 | hidden 状态 | 根本原因 | 是否需要 bringToFront |
|------|------|------|:---:|
| `Input.dispatchKeyEvent`（keyboard.type/press/down/up）| **事件丢失**，DOM 监听器收不到 | 走合成事件路由，hidden 时路由被禁 | ✅ 需要 |
| `Input.dispatchMouseEvent`（mouse.click/move）| **事件丢失或命令卡住不返回** | 同上 | ✅ 需要 |
| `Input.insertText`（文本注入）| ✅ 正常 | 走 IME 文本注入通道，不走合成事件路由 | ❌ 不需要 |
| `Runtime.evaluate`（JS 执行）| ✅ 正常 | 纯 V8 执行，与焦点/可见性无关 | ❌ 不需要 |
| `Page.navigate` / `DOM.*` / `Network.*` / 其他 | ✅ 正常 | 不依赖合成事件路由 | ❌ 不需要 |

### isTrusted 约束（为什么不能用注入脚本绕过）

合成事件（`Input.dispatchKeyEvent/dispatchMouseEvent`）投递到 DOM 后，`event.isTrusted = true`——这是 Chrome 内核级别的只读标记，等同于真实硬件事件。

**不能用注入脚本（`Page.addScriptToEvaluateOnNewDocument` + `element.dispatchEvent`）替代合成事件**：

- 注入脚本创建的事件 `isTrusted` 永远 = `false`（内核强制，`Object.defineProperty` 都改不了）
- `isTrusted=false` 的事件无法触发：表单提交（Enter）、按钮 onclick（部分框架）、反自动化检测（`if(!e.isTrusted) return`）、浏览器内置快捷键
- 注入脚本只能处理"不依赖 isTrusted 的简单文本写入"场景，不是通用解法

### v2.10.13 修复方案（forward.js ensureVisible）

`extension-new/cdp/handler/forward.js` 拦截 `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`，发送前自动执行 `ensureVisible`：

1. 保存当前 `document.activeElement`（打 `data-cdp-saved-focus` 标记）
2. `Page.bringToFront`（让 visibility 从 hidden→visible）
3. 等 `visibilitychange` 事件 + 双 rAF（确保 renderer 完成状态切换）
4. 恢复 `activeElement` 焦点（bringToFront 会重置元素焦点）
5. 发送真正的合成输入命令

**对客户端完全透明**——Playwright/Puppeteer 的 `keyboard.type()`、`mouse.click()` 直接可用，无需客户端改动。

**代价**：每次 keyboard/mouse 操作时，隔离 tab 会短暂切到前台。这是 Chrome 合成事件机制的硬限制，无法绕过。

### 已验证的压测结论（无内存泄漏）

- 100 次连续 keyboard+mouse 操作：响应时间稳定 30-33ms，页面内存零增长
- 200 次连续操作：Proxy RSS 55MB→62MB（V8 堆初始热身，非泄漏）
- `data-cdp-saved-focus` 标记零残留
- 事件投递成功率 100%

---

## 隔离模型（硬性规则）

本节定义 cdp-tunnel 的核心隔离语义。**这些是不可合并红线，任何改动不得违反。**

### 两种环境的定义

| 环境 | 含义 | 归属 |
|------|------|------|
| **用户 tab** | 用户自己手动打开、操作的浏览器标签 | 不属于任何 CDP 连接 |
| **隔离环境 tab** | CDP 连接（9221 create 模式）创建的标签，强制归入该连接专属的 Chrome Tab Group | 归属于创建它的 clientId |

### 9221 端口（create 模式）—— 等同于一个独立浏览器

连接生命周期：

1. **连接建立** → 扩展为该 clientId 预创建一个空 Chrome Tab Group（`websocket.js` `_createGroupForClient`）。该分组可见、可折叠、以 clientId 命名，用户一眼能区分。
2. **标签创建** → CDP 创建的所有 tab/page 必须被强制归入该分组（`special.js` `addTabToAutomationGroup` → `doGroup`）。
3. **断开连接** → **自动关闭整个分组 + 组内所有 tab + detach 所有 debugger**（`websocket.js` `client-disconnected` → `_closeTabGroupByClientId` + `_closeTabsByClientId`）。断开即销毁，等价于关闭了这个"浏览器"。

并发语义：**允许多个 CDP 连接同时并发**，每个连接对应独立的分组。

### 9222 端口（takeover 模式）—— 接管用户当前浏览器

- 只有一个"浏览器"概念：**直接接管用户已打开的 tab**。
- 典型场景：用户操作到一半，想让 CDP 接入，拉取并控制当前分页。
- **能拿到用户的 tab，但拿不到分组里的 tab**（`special.js` `emitAutoAttachForExistingTargets` 跳过 `isGrouped || isCDPCreated` 的 tab）。
- **不创建分组**（`websocket.js` `_createGroupForClient` 在 takeover 模式直接 return）。
- **断开连接不关 tab，只 detach debugger**（`proxy-server.js` 发 `takeover-disconnect`；扩展只 detach 不 close）。
- **有且只能有一个连接**：若已有 takeover 客户端在线，新连接被 `close(1008)` 拒绝（`proxy-server.js` `handleClientConnection`）。

### 跨连接隔离规则（双向不可见）

- **隔离环境 tab 感知不到其他分组的 tab**：`Target.getTargets` 响应按 clientId 过滤，只返回该连接自己拥有的 target（`proxy-server.js` getTargets 过滤逻辑）。
- **隔离环境 tab 也感知不到用户的 tab**：无 clientId 归属的 target 事件直接 drop（`proxy-server.js` "dropped for isolation"）。
- **跨连接操作被拦截**：`Target.attachToTarget` / `Target.closeTarget` 若 target 归属其他 client，返回 `Target is owned by another client` 错误（`proxy-server.js` 归属校验）。
- **无归属 attach 被拒绝**：create 模式下 `/devtools/page/<id>` 直连若无 owner，`close(1008)`（`proxy-server.js` `handlePageConnection`）。

### Cookie 共享

所有 tab（无论用户 tab 还是隔离环境 tab）运行在**同一个 Chrome 默认 profile**，因此 **cookie 在所有环境间共享**。除 cookie 外，target/页面/会话均按上述规则隔离。

> **已知边界**：HTTP `/json/list` 端点因无 clientId 上下文，会列出所有 page target 的 ID（不分归属），但这些 target **无法被跨归属 attach**（attach 路径有归属校验）。标准 CDP 客户端走 `Target.getTargets` 的流程则严格按 clientId 过滤，互不可见。

### 目的

**守护用户自己的浏览器 tab，不因 CDP 自动化而受影响、被误操作或被打扰。** 隔离模型的一切设计都服务于这一目标。任何削弱隔离、让分组 tab 逃逸、或让 CDP 操作波及用户 tab 的改动，均不可合并。

---

## 端口与模式对应关系

### 基本端口（v2.x）

| 端口 | 模式 | 分组行为 | 用途 |
|------|------|----------|------|
| 9221 | create | 强制分组（Chrome Tab Group） | Playwright/Puppeteer/CDP 创建新页面 |
| 9222 | takeover | 不分组 | 接管用户已打开的页面 |

### 端口池（v3.0+）

| 端口 | 模式 | 用途 |
|------|------|------|
| 9220 | takeover（端口池） | 接管用户浏览器（独立于 9222） |
| 9231-9239 | create（端口池） | 每个端口 = 一个独立的隔离环境 |

端口池行为对齐原生 Chrome `--remote-debugging-port`：
- **多客户端共享**：同一个端口可以有多个客户端同时连接，共享 tab
- **断开不清理**：客户端断开后 tab 仍存活（客户端自己用 `Target.closeTarget` 关闭）
- **端口隔离**：不同端口的 client 互不可见对方的 tab（`/json/list` 天然过滤）

配置（环境变量）：
- `POOL_SIZE=0` 禁用端口池（默认 9 个 create 端口）
- `POOL_START=9231` 端口池起始端口
- `POOL_TAKEOVER_PORT=9220` 端口池的 takeover 端口

### 端口池架构（v3.0）

端口池通过 `server/modules/port-pool.js`（PortPoolManager）实现。核心设计：

- 端口池端口（9231-9239）的 WebSocket upgrade 转发给主 proxy 的 `wss`，通过 `req._poolPortIndex` 标记区分
- `wss.on('connection')` 检查 `_poolPortIndex`：有值走 PortPoolManager 隔离逻辑，无值走现有 `handleClientConnection`
- 端口池的命令通过主 proxy 的 plugin 连接转发给扩展（带 `pool{portIndex}_{id}` 前缀）
- 扩展返回的事件按 `targetId → portIndex` 和 `sessionId → portIndex` 映射路由回正确端口
- 端口池 client 连接时发 `client-connected` 给扩展（让 `hasConnectedClient=true`，否则扩展丢弃 debugger 事件）

### 模式由端口决定

- 基本端口：`proxy-server.js` 在 takeover 端口的 upgrade 请求中设置 `req._takeoverMode = true`
- 端口池：`PortPoolManager._startCreatePort` 在 upgrade 时设置 `req._poolPortIndex`
- 客户端连接时 mode 通过 `__mode` 字段传递给扩展
- 扩展的 `ConnectionState.mode` 来自扩展配置页面的连接设置

### 端口池 vs 直连 Chrome 对比验证（v3.0.9）

使用同一 Chromium 实例、同一页面、同一套 CDP 操作，A/B 对比端口池（9231）与直连 Chrome CDP（`--remote-debugging-port`），以下场景全部一致（17/17）：

| Domain | 场景 | 直连 Chrome | 端口池 | 一致 |
|--------|------|:---:|:---:|:---:|
| Network | 前置拦截（enable 前的请求也捕获）| ✅ | ✅ | ✅ |
| Network | 请求 URL 列表 | ✅ | ✅ | ✅ |
| Network | 响应捕获（responseReceived）| ✅ | ✅ | ✅ |
| Runtime | Console.log/warn/error 事件 | ✅ | ✅ | ✅ |
| Page | addScriptToEvaluateOnNewDocument | ✅ | ✅ | ✅ |
| Page | captureScreenshot | ✅ | ✅ | ✅ |
| 重连 | 断开后重连页面存活 | ✅ | ✅ | ✅ |
| Storage | Cookie 设置/读取 | ✅ | ✅ | ✅ |
| Storage | localStorage 读写 | ✅ | ✅ | ✅ |
| Fetch | 请求拦截（requestPaused）| ✅ | ✅ | ✅ |
| Security | enable/disable | ✅ | ⚠️ | chrome.debugger 不支持 Security domain |
| Performance | getMetrics | ✅ | ✅ | ✅ |
| Tracing | start/end | ✅ | ✅ | ✅ |
| Browser | close 命令响应 | ✅ | ✅ | ✅ |

**已知限制**：`Security` domain 在 `chrome.debugger` API 下返回 `-32601 Method not found`。这是 chrome.debugger 的固有限制（非端口池 bug），不影响实际自动化场景。

验证脚本：`tests/e2e/test-key-scenarios.js`，对比报告：`tests/e2e/_port-pool-comparison-report.md`

---

## 标签分组机制

### 分组流程

1. 客户端连接 → 服务器发送 `client-connected` 事件到扩展
2. 扩展收到后调用 `_createGroupForClient(clientId, mode)` 创建空分组
3. 客户端发送 `Target.setAutoAttach` → 服务器拦截并自动创建默认页
4. 标签创建后 → `addTabToAutomationGroup` → `doGroup` 将标签加入分组
5. 分组保护：`chrome.tabs.onUpdated` 监听标签逃逸，自动重新归组

### 关键代码路径

| 文件 | 函数 | 职责 |
|------|------|------|
| `extension-new/core/websocket.js` | `_createGroupForClient` | 预创建空分组 |
| `extension-new/cdp/handler/special.js` | `addTabToAutomationGroup` | 将标签加入分组（串行队列） |
| `extension-new/cdp/handler/special.js` | `doGroup` / `doGroupQuery` | 分组三级策略（缓存→Promise→查询） |
| `extension-new/background.js` | `chrome.tabs.onUpdated` | 标签逃逸检测与重新归组 |
| `extension-new/background.js` | `chrome.tabGroups.onRemoved` | 分组被删除时自动重建 |

### takeover 模式跳过分组的检查点

以下位置都有 `if (mode === 'takeover') { return; }` 检查：
- `websocket.js` `_createGroupForClient`
- `special.js` `addTabToAutomationGroup`
- `special.js` `doGroup`

**create 模式下这些检查点绝不能被跳过。**

---

## 开发流程规范

### 自测验证流程（必须执行，不可跳过）

**任何改动都必须通过以下自测流程后才能提交。不允许让用户手动验证本应自动化测试的内容。**

#### 第 1 步：A/B 对照测试（直连 Chrome CDP vs cdp-tunnel 端口池）

**核心原则：cdp-tunnel 的行为必须和直连 Chrome 一模一样。任何差异都是 bug。**

```bash
# 用同一台 Chromium，同时开直连 RDP + 加载扩展
# A: 直连 Chrome CDP（--remote-debugging-port）
# B: cdp-tunnel 端口池（通过扩展 + chrome.debugger）
# 同一套 CDP 操作序列，断言两边结果一致

node tests/e2e/test-ab-gate.js
```

测试覆盖：createTarget / attach / navigate / evaluate / input / mouse / screenshot / cookie / localStorage / Network / getTargets。退出码 0 才算通过。

#### 第 2 步：并发测试（两阶段，对照直连）

**端口池的核心场景是多 client 并发。必须同时测直连和端口池的并发，对比失败率。**

```bash
# 模拟 xbrowser 的完整初始化序列（两阶段）：
# 阶段 1: getTargets + attach已有page + enable domains + setAutoAttach
# 阶段 2: createTarget + attach新target + navigate
# 5 并发 × 4 批 = 20 次

# 端口池测试
node tests/e2e/_2phase-auto.cjs

# 直连对照（同样的脚本，连 --remote-debugging-port）
# 失败率应和端口池一致（都接近 0%）
```

**判定标准**：端口池失败率 ≤ 直连失败率 + 5%。如果端口池明显更高，说明有 bug。

#### 第 3 步：全自动环境（不依赖用户操作）

所有测试必须自己起 Chromium + proxy + 扩展，不依赖用户的手动操作：

```
1. 起 proxy（独立端口，如 29901）
2. 起 Chromium（--load-extension 加载项目目录的 extension-new）
3. 改 config.js 的 WS_URL 指向测试端口
4. 等扩展连接（轮询 /json/version）
5. 跑测试
6. 清理（杀进程 + 删 profile + 恢复 config.js）
```

**禁止**：让用户手动 reload 扩展、让用户手动观察 Chrome 分组、让用户手动检查结果。

#### 第 4 步：扩展代码同步

改了扩展代码后，必须同步到 npm 包路径（用户安装的扩展从 npm 包加载）：

```bash
for f in core/connection-state.js core/websocket.js cdp/handler/special.js cdp/handler/forward.js; do
  cp extension-new/$f /Users/xuyingzhou/.nvm/versions/node/v25.2.1/lib/node_modules/cdp-tunnel/extension-new/$f
done
```

### 提交前检查

1. A/B Gate 测试通过（`test-ab-gate.js` 退出码 0）
2. 并发测试失败率 ≤ 直连 + 5%
3. 端口分组名正确（`CDP-{端口号}-xxx`，不是 `local`）
4. `config.js` 的 `WS_URL` 已恢复

### 测试命令

```bash
# A/B Gate（提交必须通过）
node tests/e2e/test-ab-gate.js

# 并发测试（两阶段）
node tests/e2e/_2phase-auto.cjs

# 核心冒烟测试（使用独立端口）
PORT=9231 npm run test:smoke

# 完整 E2E 测试
PORT=9231 npm run test:e2e
```

---

## 项目结构

```
server/proxy-server.js     - Node.js WebSocket 代理服务器
server/modules/config.js   - 端口配置（PORT=9221, TAKEOVER_PORT=PORT+1, 端口池配置）
server/modules/port-pool.js - 端口池管理器（v3.0，PortPoolManager）
extension-new/             - Chrome 扩展（Manifest V3）
  background.js            - Service Worker，标签事件监听中枢
  core/websocket.js        - WebSocket 连接管理，分组创建
  core/connection-state.js - 连接状态，clientId↔groupId 映射
  core/connection-manager.js - 多连接管理
  cdp/handler/special.js   - CDP 特殊命令处理，标签分组核心逻辑
  utils/config.js          - 扩展配置（WS_URL 默认端口）
  utils/helpers.js         - 分组名/颜色计算
cli/                       - CLI 工具
tests/e2e/                 - E2E 测试
```


---

## 本地部署信息（不提交 Git）

服务器部署信息（域名、端口、key 管理、启动命令）见 `DEPLOY-LOCAL.md`。
该文档已在 .gitignore，不提交到仓库，避免泄露服务器信息。

快速参考:
- 服务器: shanbox（ssh shanbox）
- 公网: `wss://cdp.shanbox.19930810.xyz:8443`
- proxy 端口: 9241（pm2: cdp-tunnel）
- 环境变量: REQUIRE_AUTH=true STRICT_VERSION=true
- key 管理: `node server/saas/key-manager.js create <name>`

详见 `DEPLOY-LOCAL.md`。
