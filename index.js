'use strict';

/**
 * cdp-tunnel — 把 Chrome 扩展（chrome.debugger）桥接成标准 CDP WebSocket 服务
 *
 * 典型用法（本地一键启动）：
 *   const cdp = require('cdp-tunnel');
 *   const { port } = await cdp.startServer({ requireAuth: true });
 *   const { pluginUrl, clientUrl } = cdp.createApiKey('张三');
 *   // 把 pluginUrl 给用户填进扩展，用 clientUrl 让 Playwright connectOverCDP 接管
 *
 * 对外服务化部署：
 *   const { port } = await cdp.startServer({
 *     requireAuth: true,
 *     strictVersion: true,
 *     adminToken: 'your-secret',
 *     externalHost: 'cdn.example.com:8443'  // 生成给用户的地址用这个 host
 *   });
 *   const key = cdp.createApiKey('用户A', { host: 'cdn.example.com:8443' });
 *
 * 客户端不需要本 SDK —— 标准 Playwright/Puppeteer 用 connectOverCDP(clientUrl) 即可。
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const auth = require('./server/saas/auth');
const { PortPoolManager } = require('./server/modules/port-pool');
const { CONFIG } = require('./server/modules/config');

const PROXY_SERVER_PATH = path.join(__dirname, 'server', 'proxy-server.js');
const BUILTIN_USER = { id: 'builtin-admin', email: 'admin@local', displayName: 'Admin' };

// ====== 内置用户（绕过注册系统，SDK 直接管理 key） ======

function ensureBuiltinUser() {
  const db = require('./server/saas/db');
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(BUILTIN_USER.id);
  if (!existing) {
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(BUILTIN_USER.id, BUILTIN_USER.email, 'builtin-no-login', BUILTIN_USER.displayName);
  }
  return BUILTIN_USER;
}

// ====== Key 管理（一 key = 一浏览器实例） ======

/**
 * 创建 API Key（= 一个浏览器实例槽位）
 * @param {string} [name] 实例名称，用于辨识
 * @param {object} [opts] { host } 自定义对外地址，如 'cdn.example.com:8443'。不传则用 EXTERNAL_HOST 环境变量或 localhost:PORT
 * @returns {{ keyId, key, name, pluginUrl, clientUrl }}
 */
function createApiKey(name, opts = {}) {
  ensureBuiltinUser();
  const keyName = name || ('browser-' + Date.now().toString(36));
  const keyInfo = auth.createApiKey(BUILTIN_USER.id, keyName);
  const host = opts.host || process.env.EXTERNAL_HOST || `localhost:${CONFIG.PORT}`;
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'ws' : 'wss';
  return {
    keyId: keyInfo.id,
    key: keyInfo.key,
    name: keyName,
    pluginUrl: `${proto}://${host}/plugin?key=${keyInfo.key}`,
    clientUrl: `${proto}://${host}/client?key=${keyInfo.key}`
  };
}

/**
 * 列出所有 Key
 * @returns {Array<{id, name, active, created_at, last_used_at}>}
 */
function listApiKeys() {
  ensureBuiltinUser();
  return auth.listApiKeys(BUILTIN_USER.id);
}

/**
 * 吊销 Key
 * @param {string} keyId
 */
function revokeApiKey(keyId) {
  ensureBuiltinUser();
  return auth.revokeApiKey(keyId, BUILTIN_USER.id);
}

/**
 * 校验 Key（返回 userId/keyId/keyName 或 null）
 * @param {string} key
 */
function validateApiKey(key) {
  return auth.validateApiKey(key);
}

// ====== 服务启动 / 停止 ======

/**
 * 编程式启动 proxy server（子进程方式，不阻塞当前进程）
 * @param {object} [opts]
 * @param {number} [opts.port] 端口，默认 9221
 * @param {boolean} [opts.requireAuth] 强制 key 鉴权
 * @param {boolean} [opts.strictVersion] 扩展版本严格校验
 * @param {string} [opts.adminToken] 管理后台 token
 * @param {string} [opts.externalHost] 对外 host（生成给用户的地址用）
 * @param {function} [opts.onLog] 日志回调 (msg) => void
 * @param {object} [opts.env] 额外环境变量
 * @returns {Promise<{ process, port, stop }>}
 */
function startServer(opts = {}) {
  const port = opts.port || CONFIG.PORT;
  const env = {
    ...process.env,
    PORT: String(port),
    REQUIRE_AUTH: opts.requireAuth ? 'true' : (process.env.REQUIRE_AUTH || ''),
    STRICT_VERSION: opts.strictVersion ? 'true' : (process.env.STRICT_VERSION || ''),
    ADMIN_TOKEN: opts.adminToken || process.env.ADMIN_TOKEN || '',
    EXTERNAL_HOST: opts.externalHost || process.env.EXTERNAL_HOST || '',
    ...(opts.env || {})
  };

  return new Promise((resolve, reject) => {
    const child = spawn('node', [PROXY_SERVER_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        child.kill('SIGTERM');
        reject(new Error(`Server failed to start within 15s on port ${port}`));
      }
    }, 15000);

    const onLine = (buf) => {
      const msg = buf.toString();
      if (opts.onLog) opts.onLog(msg);
      if (!started && msg.includes(`Server started on port ${port}`)) {
        started = true;
        clearTimeout(timeout);
        resolve({
          process: child,
          port,
          stop: () => {
            child.kill('SIGTERM');
            return new Promise(r => child.on('exit', r));
          }
        });
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!started) reject(new Error(`Server exited with code ${code} before starting`));
    });
  });
}

/**
 * 健康检查：探测某端口的 proxy 是否就绪
 * @param {number} [port] 默认 9221
 * @param {number} [timeoutMs] 默认 5000
 */
function isServerReady(port = CONFIG.PORT, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise(async (resolve) => {
    while (Date.now() - start < timeoutMs) {
      try {
        await new Promise((res, rej) => {
          const req = http.get(`http://localhost:${port}/json/version`, (r) => {
            r.on('data', () => {});
            r.on('end', res);
          });
          req.on('error', rej);
          req.setTimeout(500, () => req.destroy(new Error('timeout')));
        });
        resolve(true);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    resolve(false);
  });
}

module.exports = {
  // 服务启动 / 停止
  startServer,
  isServerReady,

  // Key 管理（一 key = 一浏览器实例）
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,

  // 高级用法
  PortPoolManager,
  CONFIG,

  // 完整 auth 模块（createUser / JWT / 密码等）
  auth
};
