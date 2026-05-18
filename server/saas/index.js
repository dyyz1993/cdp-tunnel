/**
 * CDP Tunnel SaaS 平台入口
 * 
 * 启动方式：
 *   node server/saas/index.js
 * 
 * 环境变量：
 *   PORT=9220    API 服务器端口（默认 9220）
 *   CDP_PORT=9221  CDP 代理端口（默认 9221）
 *   JWT_SECRET   JWT 签名密钥
 */
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const fs = require('fs');
const { createRouter } = require('./routes');
const auth = require('./auth');
const { getBrowsers } = require('./cdp-proxy');

// 端口配置
const API_PORT = parseInt(process.env.PORT || '9220');
const CDP_PORT = parseInt(process.env.CDP_PORT || '9221');
const WEB_UI_DIR = path.join(__dirname, 'web');

// 安装 http-proxy 依赖
// npm install http-proxy

// 创建反向代理到 CDP 服务器
const cdpProxy = httpProxy.createProxyServer({
    target: {
        host: 'localhost',
        port: CDP_PORT
    },
    ws: true  // 支持 WebSocket 代理
});

// CDP 路径列表（需要代理到 9221）
const CDP_PATHS = [
    '/plugin',
    '/client',
    '/json',  
    '/devtools'
];

// Seed 管理员用户
auth.seedAdminUser();

// 创建路由
const pluginConnections = new Set();
const getNamespace = () => ({});
const router = createRouter(pluginConnections, getNamespace);

const server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost`);

    // CDP 路径 → 代理到 9221
    const shouldProxy = CDP_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p + '/'));
    if (shouldProxy) {
        cdpProxy.web(req, res, { target: { host: 'localhost', port: CDP_PORT } }, (err) => {
            console.error('[PROXY] CDP proxy error:', err.message);
            res.writeHead(502);
            res.end('Bad Gateway');
        });
        return;
    }

    // API: 浏览器列表 — 从 CDP 代理获取
    if (req.method === 'GET' && url.pathname === '/api/browsers') {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        const token = authHeader.replace('Bearer ', '');
        const session = auth.verifyToken(token);
        if (!session) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Invalid token' }));
            return;
        }

        getBrowsers(session.userId).then(browsers => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ browsers }));
        }).catch(e => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }

    // 静态文件（Web UI）
    if (req.method === 'GET') {
        let filePath;
        if (url.pathname === '/' || url.pathname === '/index.html') {
            filePath = path.join(WEB_UI_DIR, 'index.html');
        } else {
            filePath = path.join(WEB_UI_DIR, url.pathname);
        }
        
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const extMap = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
                '.json': 'application/json'
            };
            const ext = path.extname(filePath);
            res.writeHead(200, { 'Content-Type': extMap[ext] || 'text/plain' });
            res.end(fs.readFileSync(filePath));
            return;
        }
    }

    // 其他 API 路由
    router(req, res);
});

// WebSocket 升级处理 — CDP 路径代理到 9221
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost`);
    const shouldProxy = CDP_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p + '/'));
    if (shouldProxy) {
        cdpProxy.ws(req, socket, head, { target: { host: 'localhost', port: CDP_PORT } });
    } else {
        socket.destroy();
    }
});

server.listen(API_PORT, '0.0.0.0', () => {
    console.log(`[SAAS] Server started on port ${API_PORT}`);
    console.log(`[SAAS] CDP proxy: http://localhost:${CDP_PORT}`);
    console.log(`[SAAS] Web UI: http://localhost:${API_PORT}`);
    console.log(`[SAAS] Login: admin@cdp-tunnel.dev / admin123`);
});
