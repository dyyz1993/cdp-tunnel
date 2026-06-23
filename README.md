# CDP Tunnel

<p align="center">
  <img src="extension-new/icons/icon128.png" alt="CDP Tunnel Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Bridge Chrome's debugger API to WebSocket — control your browser with Playwright/Puppeteer via CDP</strong>
</p>

<p align="center">
  Control your **existing** browser (with your logins, cookies, extensions) via standard CDP protocol.<br>
  No headless Chrome, no Selenium, no browser restart. Just connect and automate.
</p>

<p align="center">
  <a href="docs/README_CN.md">中文文档</a> ·
  <a href="https://www.npmjs.com/package/cdp-tunnel">npm</a> ·
  <a href="#quick-start">Quick Start</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/cdp-tunnel" alt="npm version">
  <img src="https://img.shields.io/github/stars/dyyz1993/cdp-tunnel?style=social" alt="GitHub stars">
  <img src="https://img.shields.io/github/forks/dyyz1993/cdp-tunnel?style=social" alt="GitHub forks">
</p>

---

## What It Does

CDP Tunnel lets standard CDP clients (Playwright/Puppeteer/CDP SDK) control your **real Chrome browser** — the one with your logins, cookies, and extensions. It works like `chrome --remote-debugging-port`, but **without restarting Chrome**.

**Key capabilities:**
- ✅ Control your existing browser (keep logins/cookies/extensions)
- ✅ Standard CDP protocol — Playwright/Puppeteer work out of the box
- ✅ Multiple isolated environments (port pool — each port = one independent "browser")
- ✅ API Key authentication for remote/cloud deployment
- ✅ Built-in admin console (browser list, key management, CDP operations)
- ✅ Tab Group isolation — automation tabs never mix with user tabs
- ✅ Takeover mode — attach to user's existing tabs

## Architecture

```
Playwright/Puppeteer                   Chrome Extension
       │                                     │
       │ ws://localhost:9221/client          │ ws://localhost:9221/plugin
       ▼                                     ▼
  ┌─────────────────────────────────────────────┐
  │              CDP Tunnel Proxy               │
  │           (Node.js WebSocket)               │
  │                                             │
  │  9221  ── create mode (port pool #0)       │
  │  9220  ── takeover mode (attach user tabs)  │
  │  9231+ ── port pool (each = isolated env)  │
  │  /admin ── web management console          │
  └─────────────────────────────────────────────┘
       │                        │
       ▼                        ▼
  chrome.debugger API     Tab Group isolation
```

## Quick Start

### 1. Install

```bash
npm install -g cdp-tunnel
cdp-tunnel setup    # Start server + auto-load extension
```

Or run from source:

```bash
git clone https://github.com/dyyz1993/cdp-tunnel.git
cd cdp-tunnel
npm install
node server/proxy-server.js
```

### 2. Load Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension-new/` directory
4. Extension connects to `ws://localhost:9221/plugin` automatically

### 3. Connect Your Automation

```javascript
// Playwright — control your real browser!
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP('http://localhost:9221');
const page = await browser.contexts()[0].newPage();
await page.goto('https://www.google.com');
console.log(await page.title());
```

```python
# Python Playwright
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://localhost:9221")
    page = browser.contexts[0].new_page()
    page.goto("https://www.google.com")
    print(page.title())
```

## Key Features

### Port Pool — Multiple Isolated Environments

Each port = one independent "browser" with its own Tab Group. Different ports can't see each other's tabs.

```bash
# Default ports
9221  ── Main create port (port pool #0)
9220  ── Takeover port (attach user's existing tabs)
9231-9239 ── Port pool (9 isolated environments)
```

```javascript
// Each port is independent
const browserA = await chromium.connectOverCDP('http://localhost:9231');
const browserB = await chromium.connectOverCDP('http://localhost:9232');
// browserA and browserB have completely separate tabs
```

### Takeover Mode — Control Existing Tabs

Connect to port `9220` to take over the user's already-open tabs (no new Tab Group created).

```javascript
const browser = await chromium.connectOverCDP('http://localhost:9220');
// Now you can see and control all user's open tabs
```

### API Key Authentication (Remote Deployment)

Enable authentication for cloud/remote deployment:

```bash
REQUIRE_AUTH=true node server/proxy-server.js

# Create an API key
node server/saas/key-manager.js create my-browser
# Output: ws://localhost:9221/plugin?key=cdp_xxxxx
```

```javascript
// Client connects with key
const browser = await chromium.connectOverCDP(
  'ws://your-server.com:9221/client?key=cdp_xxxxx'
);
```

**One key = one browser = one isolated Tab Group.** Different keys are completely isolated.

### Admin Console

Built-in web UI at `/admin`:

```
http://localhost:9221/admin
```

Features:
- 📱 Online browser list (real-time)
- 🔑 API Key management (create/revoke + copy address)
- 🔧 Tab management (list/close/switch)
- ⚡ CDP operations (evaluate JS, screenshot, new tab)
- 🎬 One-click demo

### Version Check

```bash
STRICT_VERSION=true node server/proxy-server.js
# Extension version must match proxy version, otherwise connection rejected
```

## Remote / Cloud Deployment

CDP Tunnel can be deployed to a VPS for remote browser control:

```
Remote Client ──wss──▶ Cloud Proxy ──wss──▶ User's Chrome + Extension
```

See [`docs/DEPLOY-CLOUDFLARE.md`](docs/DEPLOY-CLOUDFLARE.md) for Cloudflare Tunnel setup.

Key environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | 9221 | Main create port |
| `TAKEOVER_PORT` | 9220 | Takeover port |
| `POOL_START` | 9231 | Port pool start |
| `POOL_SIZE` | 9 | Number of port pool ports |
| `REQUIRE_AUTH` | false | Require API key |
| `STRICT_VERSION` | false | Reject version mismatch |
| `ADMIN_TOKEN` | (none) | Admin console auth token |

## CLI Commands

```bash
cdp-tunnel setup      # Start server + load extension
cdp-tunnel start      # Start server only
cdp-tunnel stop       # Stop server
cdp-tunnel status     # Check status
cdp-tunnel diagnose   # Diagnose connection
cdp-tunnel extension  # Open extension installation guide
```

## API Key Management

```bash
# Create a key (returns connection address)
node server/saas/key-manager.js create "张三的浏览器"

# List all keys
node server/saas/key-manager.js list

# Revoke a key
node server/saas/key-manager.js revoke <keyId>
```

## Testing

```bash
# Smoke tests (runs before every commit via husky pre-commit)
node tests/e2e/run-all.js

# A/B Gate (compare with direct Chrome CDP)
node tests/e2e/test-ab-gate.js

# Key isolation test
node tests/e2e/test-key-isolation.js

# Admin console test
node tests/e2e/test-admin-console.js

# Production deployment verification
PROD_WSS=wss://your-server:port PROD_KEY=cdp_xxx node tests/e2e/test-prod-deploy.js
```

## How It Works

CDP Tunnel uses Chrome's `chrome.debugger` API (available to extensions) to bridge CDP commands:

```
Playwright command (e.g., Page.navigate)
  → CDP Tunnel Proxy (WebSocket)
  → Chrome Extension (chrome.debugger.attach)
  → Chrome renders the page
  → Events flow back: Chrome → Extension → Proxy → Playwright
```

The extension acts as the bridge — it receives CDP commands via WebSocket and executes them via `chrome.debugger`. This means:
- Your browser keeps all logins, cookies, extensions
- No need to restart Chrome or use `--remote-debugging-port`
- Works with regular Chrome (not just Chromium)

**Synthetic input handling:** Chrome throttles synthetic events (keyboard/mouse) on non-active tabs. CDP Tunnel automatically calls `Page.bringToFront` before synthetic input commands, making it transparent to Playwright/Puppeteer.

## Project Structure

```
cdp-tunnel/
├── server/
│   ├── proxy-server.js          # Main proxy server
│   ├── modules/
│   │   ├── config.js            # Port configuration
│   │   └── port-pool.js         # Port pool manager (v3.0+)
│   ├── saas/
│   │   ├── auth.js              # API Key + JWT authentication
│   │   ├── key-manager.js       # Key management CLI
│   │   └── db.js                # SQLite database
│   └── admin-console.html       # Admin web UI
├── extension-new/               # Chrome Extension (Manifest V3)
│   ├── background.js            # Service Worker
│   ├── core/
│   │   ├── websocket.js         # WebSocket connection
│   │   ├── connection-state.js  # State management
│   │   └── connection-manager.js# Multi-connection
│   ├── cdp/
│   │   ├── handler/
│   │   │   ├── special.js       # Tab grouping logic
│   │   │   └── forward.js       # CDP command forwarding
│   │   └── response.js          # CDP response builder
│   └── utils/
│       ├── config.js            # Extension config
│       └── helpers.js           # Group naming/color
├── cli/                         # CLI tool
├── tests/e2e/                   # E2E tests
└── docs/                        # Documentation
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

Apache License 2.0 with Attribution Requirement. See [LICENSE](LICENSE).

---

If you use this project, please include attribution:
- Project: CDP Tunnel
- Author: dyyz1993
- Source: https://github.com/dyyz1993/cdp-tunnel
