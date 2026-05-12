#!/usr/bin/env node
'use strict';

/**
 * Test: Full Playwright lifecycle through CDP Tunnel
 *
 * Tests EVERY Playwright operation and compares timing.
 * Purpose: find which operation hangs or fails.
 *
 * 9 Phases:
 *  1. HTTP Discovery (/json/version, /json/list)
 *  2. connectOverCDP
 *  3. contexts(), pages()
 *  4. newPage()
 *  5. goto, title, evaluate, screenshot
 *  6. context isolation (newContext + newPage)
 *  7. raw CDP session
 *  8. multiple pages (create 5 + close)
 *  9. browser.close()
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19236;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const STATE_DIR = path.join(os.homedir(), '.cdp-tunnel');
const STATE_FILE = path.join(STATE_DIR, 'extension-state.json');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;

const results = [];

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    configOriginal.replace(
      /WS_URL:\s*'ws:\/\/localhost:9221\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (configOriginal) {
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    configOriginal = null;
  }
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(port, '/json/version');
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function waitForExtension(port, maxWait = 45000) {
  await sleep(5000);
  let reqId = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const id = ++reqId;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off('message', handler);
          reject(new Error('timeout'));
        }, 5000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      });
      ws.close();
      if (result && result.targetInfos && result.targetInfos.length > 0) return true;
    } catch (e) {
      log('SETUP', `  Waiting for extension... (${e.message})`);
    }
    await sleep(3000);
  }
  return false;
}

async function timeOperation(name, fn, timeoutMs = 30000) {
  const start = Date.now();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
  );

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    const duration = Date.now() - start;
    log(name, `OK (${duration}ms)`);
    results.push({ name, ok: true, duration, result });
    return { ok: true, duration, result };
  } catch (err) {
    const duration = Date.now() - start;
    log(name, `FAILED (${duration}ms): ${err.message}`);
    results.push({ name, ok: false, duration, error: err.message });
    return { ok: false, duration, error: err.message };
  }
}

function cleanup() {
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    if (chromeProcess._profile) {
      try { fs.rmSync(chromeProcess._profile, { recursive: true, force: true }); } catch {}
    }
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

async function runTest() {
  console.log('=== Playwright Full Lifecycle Test ===\n');

  const proxyLogs = [];

  try {
    // === Setup ===
    log('SETUP', 'Patching extension config...');
    patchConfig(PROXY_PORT);

    log('SETUP', 'Starting proxy server...');
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'info' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proxyProcess.stdout?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => {
        proxyLogs.push(l);
        if (
          l.includes('ERROR') ||
          l.includes('WARN') ||
          l.includes('SEND') ||
          l.includes('RECV') ||
          l.includes('SESSION') ||
          l.includes('ROUTE') ||
          l.includes('MAPPED')
        ) {
          log('PROXY', l);
        }
      });
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => log('PROXY-ERR', l));
    });

    log('SETUP', `Proxy started (PID: ${proxyProcess.pid})`);

    if (!await waitForProxy(PROXY_PORT)) {
      throw new Error('Proxy did not become ready');
    }
    log('SETUP', 'Proxy is ready');

    log('SETUP', 'Starting Chrome with extension...');
    const userDataDir = `/tmp/pw-full-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;
    log('SETUP', `Chrome started (PID: ${chromeProcess.pid})`);

    log('SETUP', 'Waiting for extension to connect...');
    if (!await waitForExtension(PROXY_PORT)) {
      throw new Error('Extension did not connect');
    }
    log('SETUP', 'Extension connected!');

    await sleep(2000);

    // === Phase 1: HTTP Discovery ===
    console.log('\n--- Phase 1: HTTP Discovery ---');

    await timeOperation('HTTP /json/version', async () => {
      return httpGet(PROXY_PORT, '/json/version');
    });

    await timeOperation('HTTP /json/list', async () => {
      return httpGet(PROXY_PORT, '/json/list');
    });

    // === Phase 2: Playwright connectOverCDP ===
    console.log('\n--- Phase 2: Playwright Connection ---');

    let browser;
    const connResult = await timeOperation('PW connectOverCDP', async () => {
      browser = await chromium.connectOverCDP(`http://localhost:${PROXY_PORT}`);
      return { contexts: browser.contexts().length };
    }, 30000);

    if (!browser) {
      log('FATAL', 'Cannot connect to browser, aborting');
      throw new Error('Playwright connectOverCDP failed');
    }

    // === Phase 3: Basic Playwright Operations ===
    console.log('\n--- Phase 3: Basic Operations ---');

    let contexts;
    await timeOperation('PW contexts()', async () => {
      contexts = browser.contexts();
      log('DETAIL', `  ${contexts.length} context(s)`);
      return { count: contexts.length };
    });

    let defaultContext = contexts?.[0];
    if (defaultContext) {
      await timeOperation('PW context.pages()', async () => {
        const pages = defaultContext.pages();
        log('DETAIL', `  ${pages.length} page(s) in default context`);
        return { count: pages.length };
      });
    }

    results.push(await timeOperation('PW pages() count', async () => {
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('No default context');
      const pages = ctx.pages();
      log('DETAIL', `  ${pages.length} existing page(s) found (client isolation: 0 = expected for user tabs)`);
      return pages;
    }));

    // === Phase 4: Create New Page ===
    console.log('\n--- Phase 4: Create New Page ---');

    let page;
    await timeOperation('PW newPage()', async () => {
      if (!defaultContext) {
        defaultContext = await browser.newContext();
      }
      page = await defaultContext.newPage();
      return { url: page.url() };
    });

    // === Phase 5: Navigate ===
    console.log('\n--- Phase 5: Navigation ---');

    if (page) {
      await timeOperation('PW goto about:blank', async () => {
        await page.goto('about:blank', { timeout: 10000 });
      });

      await timeOperation('PW goto about:blank (2nd)', async () => {
        await page.goto('about:blank', { timeout: 10000 });
      });

      await timeOperation('PW title()', async () => {
        return await page.title();
      });

      await timeOperation('PW evaluate()', async () => {
        return await page.evaluate(() => document.title);
      });

      await timeOperation('PW screenshot()', async () => {
        const buf = await page.screenshot({ type: 'png' });
        return { size: buf.length };
      });
    }

    // === Phase 6: Create Second Context (isolation) ===
    console.log('\n--- Phase 6: Context Isolation ---');

    let context2, page2;
    await timeOperation('PW newContext()', async () => {
      context2 = await browser.newContext();
      return {};
    });

    if (context2) {
      await timeOperation('PW context2.newPage()', async () => {
        page2 = await context2.newPage();
        return { url: page2.url() };
      });

      if (page2) {
        await timeOperation('PW context2 goto', async () => {
          await page2.goto('about:blank', { timeout: 10000 });
        });
      }
    }

    if (defaultContext && context2) {
      const ctx1Pages = defaultContext.pages().length;
      const ctx2Pages = context2.pages().length;
      log('ISOLATION', `Context 1: ${ctx1Pages} pages, Context 2: ${ctx2Pages} pages`);
    }

    // === Phase 7: CDP Session (raw) ===
    console.log('\n--- Phase 7: Raw CDP Session ---');

    if (page) {
      await timeOperation('PW CDP session create', async () => {
        const cdpSession = await page.context().newCDPSession(page);
        return { sessionId: cdpSession._sessionId };
      });

      await timeOperation('PW CDP Runtime.evaluate', async () => {
        const cdpSession = await page.context().newCDPSession(page);
        const result = await cdpSession.send('Runtime.evaluate', { expression: '1 + 1' });
        log('DETAIL', `  Result: ${JSON.stringify(result)}`);
        return result;
      });
    }

    // === Phase 8: Multiple Pages ===
    console.log('\n--- Phase 8: Multiple Pages ---');

    if (defaultContext) {
      await timeOperation('PW create 5 pages', async () => {
        const pages = [];
        for (let i = 0; i < 5; i++) {
          const p = await defaultContext.newPage();
          await p.goto('about:blank', { timeout: 5000 });
          pages.push(p);
        }
        return { count: pages.length };
      }, 60000);

      await timeOperation('PW close extra pages', async () => {
        const pages = defaultContext.pages();
        let closed = 0;
        for (let i = pages.length - 1; i > 0; i--) {
          await pages[i].close({ timeout: 5000 });
          closed++;
        }
        return { closed };
      }, 60000);
    }

    // === Phase 9: Cleanup ===
    console.log('\n--- Phase 9: Cleanup ---');

    await timeOperation('PW browser.close()', async () => {
      await browser.close();
    }, 10000);

    // === Results Summary ===
    console.log('\n=== RESULTS ===');
    let passed = 0;
    let failed = 0;
    results.forEach(r => {
      const status = r.ok ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${r.name} (${r.duration}ms)${r.ok ? '' : ' - ' + r.error}`);
      if (r.ok) passed++;
      else failed++;
    });
    console.log(`\nTotal: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.log('\n=== PROXY LOGS (last 50 lines) ===');
      proxyLogs.slice(-50).forEach(l => console.log(`  ${l}`));
    }
    console.log('===================\n');

    cleanup();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    console.error(err.stack);

    if (results.length > 0) {
      console.log('\n=== PARTIAL RESULTS ===');
      results.forEach(r => {
        const status = r.ok ? 'PASS' : 'FAIL';
        console.log(`  [${status}] ${r.name} (${r.duration}ms)${r.ok ? '' : ' - ' + r.error}`);
      });
    }

    console.log('\n=== PROXY LOGS (last 80 lines) ===');
    proxyLogs.slice(-80).forEach(l => console.log(`  ${l}`));

    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

runTest();
