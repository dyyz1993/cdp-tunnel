# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
