# CLAUDE.md - CDP Tunnel 项目开发原则与规范

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

---

## 端口与模式对应关系

| 端口 | 模式 | 分组行为 | 用途 |
|------|------|----------|------|
| 9221 | create | 强制分组（Chrome Tab Group） | Playwright/Puppeteer/CDP 创建新页面 |
| 9222 | takeover | 不分组 | 接管用户已打开的页面 |

- 模式由端口决定：`proxy-server.js` 在 takeover 端口的 upgrade 请求中设置 `req._takeoverMode = true`
- 客户端连接时 mode 通过 `__mode` 字段传递给扩展
- 扩展的 `ConnectionState.mode` 来自扩展配置页面的连接设置

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

### 提交前检查

1. 标签分组是否正常工作（9221 端口连接后标签必须在分组内）
2. takeover 模式是否正确跳过分组（9222 端口）
3. 用户标签是否被保护（不受 CDP 操作影响）
4. `config.js` 的 `WS_URL` 是否已恢复为用户端口

### 测试命令

```bash
# 核心冒烟测试（使用独立端口）
PORT=9231 npm run test:smoke

# 完整 E2E 测试
PORT=9231 npm run test:e2e
```

---

## 项目结构

```
server/proxy-server.js     - Node.js WebSocket 代理服务器
server/modules/config.js   - 端口配置（PORT=9221, TAKEOVER_PORT=PORT+1）
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
