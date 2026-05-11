# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
