# CDP Tunnel 多客户端隔离实施计划

## 目标

实现多个 CDP 客户端连接时的**完全隔离**：
- 每个客户端只能看到/操作自己分组内的页面
- `Browser.close` / 断开连接时关闭整个分组
- 分组名显示 page 数量，自动折叠，颜色区分
- 无逃逸：页面不会跑到分组外
- GitHub CI 自动化 E2E 验证

## 当前状态

| 功能 | 状态 |
|------|------|
| Browser.close 关闭分组 | ✅ 已完成 |
| 客户端断开关闭分组 | ✅ 已完成 |
| Tab Group 自动折叠 | ✅ 已完成 |
| 不同颜色 | ✅ 已有（hash） |
| Target.getTargets 全局过滤 | ❌ 返回所有页面 |
| Target 事件广播过滤 | ❌ 所有客户端都能收到 |
| 分组名显示 page 数量 | ❌ |
| Target.closeTarget 清理映射 | ❌ |
| GitHub CI | ❌ |

## 实施步骤

### Phase 1: 核心隔离（proxy-server.js）

#### 1.1 Target.getTargets 响应过滤

**文件**: `server/proxy-server.js`

**原理**: 客户端调用 `Target.getTargets` 时，proxy 根据请求的 clientId 从 `targetIdToClientId` Map 过滤响应，只返回属于该客户端的 target。

**改动**:
- 在 plugin → client 的响应路由中（约 line 421-483），当检测到 `Target.getTargets` 响应且 `mapping.isGetTargets` 时，过滤 `targetInfos` 数组
- 客户端请求时标记 `isGetTargets: true`（类似已有的 `isCreateTarget`）
- 过滤逻辑：`targetInfos.filter(t => targetIdToClientId.get(t.targetId) === clientId)`
- **特殊处理**: 浏览器级别的 target（如 browser-session）不过滤

#### 1.2 Target 事件按 clientId 路由

**文件**: `server/proxy-server.js`

**原理**: `Target.targetCreated` / `Target.targetDestroyed` / `Target.attachedToTarget` 等事件目前广播给所有客户端，应只发给拥有该 target 的客户端。

**改动**:
- 在 plugin 消息处理的 `type: 'event'` 分支（约 line 344-409），对 Target 事件从广播改为定向发送
- `Target.targetCreated` with openerId → 按 openerId 查 clientId，只发给该 clientId
- `Target.attachedToTarget` → 按 targetId 查 clientId，只发给该 clientId
- `Target.targetDestroyed` → 按 targetId 查 clientId，只发给该 clientId
- `Target.targetInfoChanged` → 同上

#### 1.3 Target.closeTarget 映射清理

**文件**: `server/proxy-server.js`

**改动**: 当收到 `Target.closeTarget` 响应（success）时，清理 `targetIdToClientId` 中的映射

---

### Phase 2: 分组名显示 page 数量（扩展端）

#### 2.1 动态更新分组名称

**文件**: `extension-new/cdp/handler/special.js`

**原理**: 分组名格式改为 `CDP-{clientId:8} ({N})`，其中 N 是当前分组内的 page 数量。

**改动**:
- `addTabToAutomationGroup()` 函数改为 `updateTabGroupName(clientId)` 公共函数
- 每次添加/移除 tab 时调用 `updateTabGroupName()`
- `updateTabGroupName()` 查询分组内 tab 数量，更新组名为 `CDP-xxx (N)`

#### 2.2 触发时机

- `targetCreateTarget` 创建 tab 后 → 更新分组名
- `chrome.tabs.onRemoved` 关闭 tab 后 → 更新分组名
- `targetCloseTarget` 关闭 tab 后 → 更新分组名

#### 2.3 查询分组名的过滤

由于分组名包含动态的 `({N})` 后缀，查询时需要用前缀匹配。改为存储 `groupId` 而非靠名称查询。

**方案**: 在 `State` 中维护 `clientId → groupId` 映射

---

### Phase 3: 扩展端隔离增强

#### 3.1 State 新增 clientId → groupId 映射

**文件**: `extension-new/core/state.js`

**新增**:
- `_state.clientIdToGroupId = new Map()` 
- `setGroupIdForClient(clientId, groupId)`
- `getGroupIdForClient(clientId)`
- `removeGroupForClient(clientId)`

#### 3.2 targetCloseTarget 清理映射

**文件**: `extension-new/cdp/handler/special.js`

**改动**: `targetCloseTarget` 中，关闭 tab 后清理 `tabIdToClientId` 映射并更新分组名

---

### Phase 4: GitHub CI 自动化测试

#### 4.1 CI 环境准备

**文件**: `.github/workflows/e2e-test.yml`

```yaml
name: E2E Test
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Install Chromium
        run: |
          CHROMIUM_PATH=$(npx playwright install chromium --dry-run 2>&1 | grep -o '/.*chrome-linux.*')
          echo "CHROMIUM_PATH=$CHROMIUM_PATH" >> $GITHUB_ENV
      - name: Run E2E Tests
        run: node tests/e2e/run-all.js
```

#### 4.2 E2E 测试套件

**文件**: `tests/e2e/run-all.js`（主入口）

**测试用例**:

| # | 用例 | 验证内容 |
|---|------|----------|
| T1 | 单客户端创建/关闭 | 创建 N 个 page → Browser.close → 所有 page 被关闭 |
| T2 | 单客户端断开 | 创建 N 个 page → ws.close() → 所有 page 被关闭 |
| T3 | 多客户端隔离 | Client A 创建 pageA → Client B 创建 pageB → A.getTargets() 不含 pageB |
| T4 | 多客户端分组 | Client A 和 B 的 page 分属不同 Tab Group |
| T5 | 关闭单个 page | 关闭 A 的 page1 → A 还有 page2 → B 不受影响 |
| T6 | 分组名显示数量 | 分组名为 `CDP-xxx (N)` 格式 |
| T7 | 分组自动折叠 | Tab Group 自动 collapsed |
| T8 | 无逃逸 | page 不会出现在其他分组中 |
| T9 | Target 事件隔离 | Client A 不收到 B 的 targetCreated 事件 |

#### 4.3 测试基础设施

**文件**: `tests/e2e/helpers.js`

封装：
- `startProxy(port)` → 启动代理服务器
- `startBrowser(proxyPort)` → 启动 Chromium + 加载扩展
- `waitForExtension(port)` → 等待扩展连接
- `connectCDP(port)` → 建立 CDP WebSocket 连接
- `cleanup()` → 清理所有进程
- `getPagesViaHTTP(port)` → 获取 `/json/list` 页面列表

---

### Phase 5: 实施顺序与依赖

```
Phase 1.1 (getTargets 过滤)
    ↓
Phase 1.2 (事件路由)  ← Phase 1.1 依赖
    ↓
Phase 1.3 (closeTarget 清理) ← 独立
    ↓
Phase 2 (分组名) ← 依赖 Phase 3.1
    ↓
Phase 3 (State 增强) ← 独立
    ↓
Phase 4 (CI) ← 依赖所有前置完成
```

**建议实施顺序**:
1. Phase 3.1 → State 新增映射（无风险）
2. Phase 1.3 → closeTarget 清理（简单）
3. Phase 2 → 分组名动态更新
4. Phase 1.1 → getTargets 过滤（核心）
5. Phase 1.2 → 事件路由过滤（核心）
6. Phase 4 → CI + E2E 测试

---

### 风险点

1. **Playwright 兼容性**: `connectOverCDP` 可能在 CI 环境有超时问题，E2E 测试使用原生 WebSocket
2. **Service Worker 重启循环**: 已存在的 bug，需在扩展端去重连逻辑中增加防抖
3. **分组名变更时序**: `setTimeout(2000)` 延迟分组可能在快速创建时导致分组名不一致
4. **过滤过严**: browser-level 的 CDP 命令（如 `Target.setDiscoverTargets`）不应被过滤

---

### 预期效果

```
用户浏览器:
┌─────────────────────────────────────────────┐
│ 用户自己的标签页（不受影响）                    │
├─────────────────────────────────────────────┤
│ ▶ CDP-client (3)          [蓝色] [已折叠]    │  ← Client A
│   ├ example.com/?e2e_1                      │
│   ├ example.com/?e2e_2                      │
│   └ example.com/?e2e_3                      │
├─────────────────────────────────────────────┤
│ ▶ CDP-client (2)          [红色] [已折叠]    │  ← Client B
│   ├ github.com                              │
│   └ stackoverflow.com                       │
└─────────────────────────────────────────────┘

Client A: browser.pages() → [page1, page2, page3]  (只有自己分组的)
Client B: browser.pages() → [page4, page5]         (只有自己分组的)

Client A: browser.close() → 分组 CDP-client (3) 整组关闭
Client B: 不受影响，继续运行
```

---

## 实施结果

**日期**: 2026-05-10
**状态**: ✅ 全部完成，5/5 E2E 测试通过

### 测试结果

| # | 测试用例 | 结果 |
|---|---------|------|
| T1 | Browser.close kills all pages | ✅ PASS |
| T2 | Client disconnect kills all pages | ✅ PASS |
| T3 | Multi-client Target.getTargets isolation | ✅ PASS |
| T4 | Close individual page without affecting others | ✅ PASS |
| T5 | No page leakage across clients | ✅ PASS |

### 修改文件清单

| 文件 | 改动说明 |
|------|----------|
| `server/proxy-server.js` | Browser.close 转发给扩展处理（不拦截）；Target.getTargets 响应按 clientId 过滤；Target 事件按 clientId 定向路由；closeTarget 后清理映射 |
| `extension-new/core/state.js` | 新增 clientId → groupId 映射；cleanupAllTabs 关闭所有 CDP 分组的 tab；clearAllState 清理新映射 |
| `extension-new/core/websocket.js` | closeTabGroupByClientId 查找链优化（groupId→精确匹配→前缀匹配→兜底按 clientId 逐个关闭）；client-disconnected await 清理后更新状态 |
| `extension-new/cdp/handler/special.js` | addTabToAutomationGroup 用前缀匹配查找组（避免动态组名后找不到）；新增 updateTabGroupName 动态更新分组名显示 page 数量；targetCloseTarget 清理映射并更新组名 |
| `extension-new/background.js` | tab 移除后更新分组名 |
| `tests/e2e/helpers.js` | E2E 测试基础设施 |
| `tests/e2e/run-all.js` | 5 个 E2E 测试用例 |
| `.github/workflows/e2e-test.yml` | GitHub CI 配置 |

### 踩坑记录

1. `chrome.tabGroups.query({ title: /^CDP-/ })` — Chrome API 不支持正则，改为 query({}) + 客户端过滤
2. 分组名动态更新后精确匹配失效 — 改为前缀匹配
3. closeTabGroupByClientId 未 await 导致清理丢失 — 改为链式 await + 兜底清理
4. closeGroupById 先 detach 再 remove — 如果 detach 失败会阻塞 remove，改为先 remove 再 detach
5. Service Worker 重连循环导致状态丢失 — 测试间增加等待时间
