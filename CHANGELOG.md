# Changelog

All notable changes to this project will be documented in this file.

## [3.6.0] - 2026-06-23
### Added
- **云管理控制台**：proxy 内置管理网页 `/admin`，查看在线浏览器、管理 key、CDP 快捷操作
- **Tab 管理**：列表/关闭/切换标签页，关闭浏览器
- **快捷操作 + 一键演示**：打开百度、截图、执行 JS、自动搜索演示
- **创建浏览器入口**：直观创建新分组，生成完整地址一键复制
- **按 key 隔离分组**：每个 key 独立端口池端口 session，listtabs 只看自己的 tab
- test-key-isolation.js（5 项）、test-admin-console.js（10 项）自动化测试

### Changed
- 分组名按 API Key 名称命名（CDP-张三的浏览器），一眼看出是谁的
- 扩展端 buildGroupName/_createGroupForClient/doGroup 支持 groupName
- listtabs 走 /client 路径（按 key 过滤，不入侵用户 tab）

### Fixed
- closebrowser 正确关闭分组（clientId 按 key 反查 + client-disconnected）
- keySessions constructor 补全（git checkout 遗漏）
- doGroup 实际建分组时 groupName 没传（根因：state 没存 groupName）

## [3.5.0] - 2026-06-22
### Added
- **API Key 鉴权**：proxy 支持 `REQUIRE_AUTH=true` 强制鉴权，一个 key 绑定一个浏览器。扩展连 `/plugin?key=xxx`，客户端连 `/client?key=xxx`，不同 key 互不可见。新增 `server/saas/key-manager.js` 手动管理 key（创建/列出/吊销）。
- **版本校验加强**：`STRICT_VERSION=true` 时扩展版本与 proxy 不一致直接拒绝连接（close 4002），避免老扩展与新 proxy 不兼容。
- **远程部署支持**：proxy 监听 0.0.0.0，可通过 nginx/Cloudflare 反代暴露到公网。新增 `docs/DEPLOY-CLOUDFLARE.md` 部署文档。
- 新增自动化测试：`test-api-key-auth.js`（鉴权 7 项）、`test-version-check.js`（版本校验 3 项）、`test-prod-deploy.js`（生产环境验证 10 项）。
- 扩展配置页优化：带 key 的 URL 自动隐藏明文（防截图泄露），显示 🔑 鉴权标识，CDP 地址自动带 key。

### Changed
- **9221 主端口纳入端口池**：9221 不再走老的 create 路径，改为端口池第 0 个 session（pool_9221），与 9231-9239 行为完全一致。takeover（9220）保持原逻辑。
- 端口池 `/json/version` `/json/list` 支持尾斜杠（修复 Playwright connectOverCDP 404）。
- pre-commit smoke test 从 3 个增加到 5 个（25 checks）。

### Fixed
- 修复 `attachedToTarget` 事件 sessionId 不注册导致 Playwright evaluate 卡死的根因（auto-attach 场景 targetId 可能未注册）。
- 修复端口池 `closeTarget` 响应 `session.attachedTargets` 字段不存在的 TypeError。
- 修复 SaaS `auth.js` 的 `datetime("now")` SQL 语法错误（双引号→单引号）。
- 修复 `validateApiKey` 作用域 bug（定义在 try 块内导致 HAS_SAAS=true 时崩溃）。

## [3.0.0] - 2026-06-19
### Added
- **端口池架构**：proxy 现在支持多端口隔离。每个 create 端口（默认 9222-9230）= 一个独立的隔离环境，不同端口的 client 互不可见对方的 tab。对齐原生 Chrome `--remote-debugging-port` 行为：多客户端可连同一端口、断开不清理 tab。
- 新增 `server/modules/port-pool.js`：端口池管理器，按 portIndex 隔离 target/session 事件路由
- 新增 `test-port-isolation.js`：验证不同端口的 client 互不可见（6 项检查）
- `run-all.js` 测试时自动禁用端口池（`POOL_SIZE=0`）避免端口冲突

### Changed
- `config.js` 新增 `POOL_TAKEOVER_PORT`（9220）、`POOL_START`（9222）、`POOL_SIZE`（9）配置
- 现有 9221/9222 行为完全不变（端口池是额外新增的端口）

### 配置
- `POOL_SIZE=0` 禁用端口池（默认 9 个 create 端口）
- `POOL_START=9222` 端口池起始端口
- `POOL_TAKEOVER_PORT=9220` 端口池的 takeover 端口

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.14] - 2026-06-19
### Fixed
- **长时间运行后并发 createTarget 偶发 page 停留 about:blank**：`sessionToClientId` 映射表泄漏——当 targetId 归属未定时，L900 将 `targetId` 误存为 session 的 value（应为 clientId），导致 `cleanupClient` 按 clientId 匹配时永远清不掉这些条目。proxy 长时间运行后 `sessionToClientId` 无限增长，新 client 的事件可能命中过期映射导致路由错误。修复：归属未定时暂存到 `pendingSessionToClientId`，归属绑定后补绑；`cleanupClient` 补清理 `pendingAttachedEvents`/`pendingTargetCreatedEvents`/`pendingSessionToClientId`。实测 200 次连/断后所有 Map 稳定为 0（修复前 sessionToClientId 线性增长至 300+）。

## [2.10.13] - 2026-06-17
### Fixed
- **Input.dispatchKeyEvent / dispatchMouseEvent 在隔离 tab 上丢失**：隔离 tab 默认 `visibility=hidden`（`active:false` + 折叠分组），Chromium 在此状态下丢弃合成输入事件（keyboard/mouse），导致 Playwright/Puppeteer 的 `keyboard.type()`、`mouse.click()` 等操作静默失效。`forward.js` 现在在发送合成输入命令前自动执行 `Page.bringToFront` + 等待 `visibilitychange` + 恢复元素焦点，确保事件能投递到 DOM。`insertText` 和 `Runtime.evaluate` 不受影响（不走合成事件路由），无需此处理。

### Added
- E2E 测试 `test-input-delivery.js`：验证 keyboard/mouse/click/Enter 四类合成输入事件在隔离 tab 上能正确投递到 DOM

## [2.5.8] - 2026-05-12
### Fixed
- 修复 `websocket.js` 中 `startGroupMonitor` 函数末尾代码重复导致的 JS 语法错误（该错误导致扩展完全无法加载）

## [2.5.7] - 2026-05-12
### Fixed
- 恢复 `addTabToAutomationGroup` 的 `cdpClients[0]` fallback 机制：当 `clientId` 为空时，如果存在已连接 client 则 fallback 到第一个 client 强制分组，避免逃逸

## [2.5.6] - 2026-05-12
### Added
- `doGroup` 分组失败自动重试 3 次（500ms 间隔），提高首次分组成功率
- 分组逃逸监控日志增强：记录每个 tab 的 groupId、clientId、预期分组状态

### Fixed
- 分组逃逸监控跳过 `clientId` 为空或 pre-existing 的 tab

## [2.5.5] - 2026-05-12
### Changed
- 分组逃逸监控间隔从 10 秒缩短为 5 秒，更快检测并修复逃逸 tab

## [2.5.4] - 2026-05-12
### Added
- `startGroupMonitor()`: 每 10 秒扫描所有 attached tab，检测逃逸（有 clientId 但无 groupId）的 tab，自动强制归组

### Fixed
- Proxy 拦截跨客户端 `Target.closeTarget` 和 `Target.attachToTarget`，返回 `Target is owned by another client` 错误
- `buildGroupName` 改用末尾 8 位随机后缀，确保各客户端组名唯一

## [2.5.3] - 2026-05-12
### Fixed
- `buildGroupName` 改用 `clientId.substring(clientId.length - 8)` 取末尾随机后缀，修复所有 client 组名相同（都是 `CDP-client_1`）的问题

### Added
- 压力测试 `test-stress-isolation.js`：3 个并发 CDP 客户端各执行 10+ 次创建/关闭/切换操作，验证隔离性、分组独立性和断连清理
- `Tab.getGroupInfo` handler：直接查询分组是否创建成功

## [2.5.2] - 2026-05-12
### Added
- `addTabToAutomationGroup` 改用轮询方案：`chrome.tabs.get` 每 200ms 检查 tab 状态，加载完成后再分组（最多等 4 秒后强制分组），无需 setTimeout(500) 或 chrome.tabs.onUpdated

### Fixed
- `addTabToAutomationGroup` 的分组操作改为等 tab 状态 `complete` 后再执行，确保 `chrome.tabs.group` 调用成功

## [2.5.1] - 2026-05-12
### Fixed
- CLI 更新命令改用 `npm install -g cdp-tunnel@latest`，修复 `npm update -g` 偶发的 `Cannot read properties of null` 错误

## [2.5.0] - 2026-05-12
### Added
- 多客户端隔离：CDP 客户端只能看到自己创建的 tab（`Target.getTargets` 过滤）
- 用户 tab 不可见：`emitAutoAttachForExistingTargets` 跳过非 CDP tab，不发事件不 attach
- 目标事件缓存：`pendingTargetCreatedEvents` 修复事件先于 response 到达时的丢包问题

### Fixed
- `closeGroupById` 按 `clientId` 过滤 tab，避免断连时误杀其他 client 的 tab
- `addTabToAutomationGroup` 去掉 `cdpClients[0]` fallback，无 clientId 不分组
- `buildGroupName` 使用稳定 `CDP-<hash>` 而非 `CDP #<index>`（index 随 client 断连变化）

## [2.1.0] - 2025-05-11

### Added
- `preExistingTabIds` tracking: tabs opened by user BEFORE CDP connect are preserved on disconnect
- `CDPUtils.buildGroupName` / `getGroupBaseName` / `findGroupByName` / `getGroupColorForClient` — unified group helpers
- E2E test: `test-tab-group-isolation.js` — single client group + user tab survival
- E2E test: `test-multi-client-group-isolation.js` — multi-client group isolation + user tab survival

### Fixed
- **User tabs no longer closed on CDP disconnect**: `emitAutoAttachForExistingTargets` marks pre-existing tabs instead of grouping them; disconnect only closes grouped (CDP-created) tabs
- **Unified tab group naming**: `CDP #1 (N)` instead of inconsistent `CDP-<hash>` / `CDP-Automation` / `CDP-<timestamp>`
- **Unified group lookup**: all 3 files (`special.js`, `background.js`, `websocket.js`) now use `CDPUtils.findGroupByName` (prefix match)
- **Removed dead `popup.html` / `popup.js`** (no `default_popup` in manifest)

## [2.0.0] - 2025-05-11

### Added
- Landing page at `docs/index.html` with dark/light mode, feature showcase, CLI reference, and comparison table
- `CHANGELOG.md` for version history tracking
- `engines` field in package.json (Node.js >= 16)
- `repository`, `homepage`, `bugs` fields in package.json
- Expanded npm keywords for better discoverability

### Changed
- **Breaking**: package.json `description` now in English for npm discoverability
- Moved 47 root-level test/debug scripts to `tests/scratch/` — cleaner repository
- Extracted duplicate `String.prototype.hashCode` from `background.js` and `special.js` into shared `utils/helpers.js`
- Removed dead `popup.html` and `popup.js` (unused since manifest has no `default_popup`)

## [1.7.0] - 2025-05-10

### Added
- `/json/version` returns Chrome-compatible format (Browser, User-Agent, V8-Version, webSocketDebuggerUrl)
- `/json/list` includes `devtoolsFrontendUrl` and `faviconUrl` fields
- agent-browser `--cdp` compatibility via standard Chrome DevTools Protocol endpoints
- `emitAutoAttachForExistingTargets` now attaches unattached pages — fixes `pages()` returning empty
- CLI `--version` reads from package.json instead of hardcoded value

### Fixed
- Duplicate target events: `handleDebuggerEvent` in `debugger.js` now filters `Target.*` events
- CLI `update` command: skips when already latest version, uses `fs.readFileSync` (not require cache), added timeouts

## [1.6.1] - 2025-05-09

### Fixed
- Auto-mute: `muteTabIfNeeded()` called in ALL attach paths

### Added
- Custom CDP command `Tab.getMuteStatus` for verifying mute state from tests

## [1.6.0] - 2025-05-09

### Added
- `--auto-restart` flag: proxy detects plugin disconnect + client connect → auto-launches Chrome
- One-command `cdp-tunnel start`: auto-detects Chrome state, launches or guides user
- Auto-mute tabs when attached by automation
- Dynamic tab group names `CDP-{clientId:8} ({N})` with auto-collapse

## [1.5.1] - 2025-05-08

### Fixed
- `Browser.close` forwarded to extension (not intercepted by proxy)

## [1.5.0] - 2025-05-08

### Added
- Multi-client CDP isolation: Target.getTargets filtered by clientId
- Target events routed to owning client only
- `closeGroupById` closes tabs FIRST then detaches debugger

## [1.3.1] - 2025-05-07

### Added
- CLI `diagnose` command: 6-step health check (proxy, HTTP, extension, targets, Chrome, Playwright)

## [1.3.0] - 2025-05-07

### Added
- CLI help with usage examples
- `--watchdog` crash recovery mode

## [1.0.0] - 2025-05-05

### Added
- Initial release
- Chrome Extension CDP Proxy via `chrome.debugger` API
- WebSocket endpoint at `localhost:9221`
- Playwright and Puppeteer compatibility
- Configuration page with live dashboard
- E2E test suite with CI/CD pipeline
