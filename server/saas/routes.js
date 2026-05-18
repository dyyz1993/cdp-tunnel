/**
 * SaaS REST API 路由
 */
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');

function createRouter(pluginConnections, getNamespace) {
    // 返回 express 风格的 router 函数：fn(req, res)
    const routes = [];

    function get(method, path, handler) {
        routes.push({ method, path, handler });
    }

    function post(method, path, handler) {
        routes.push({ method: 'POST', path, handler });
    }

    function parseBody(req) {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve({}); }
            });
        });
    }

    function json(res, data, status = 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    function error(res, message, status = 400) {
        json(res, { error: message }, status);
    }

    // ====== 认证中间件 ======
    function requireAuth(req) {
        const authHeader = req.headers['authorization'];
        if (!authHeader) return null;
        const token = authHeader.replace('Bearer ', '');
        return auth.verifyToken(token);
    }

    // ====== Auth Routes ======

    post('POST', '/api/auth/login', async (req, res) => {
        const body = await parseBody(req);
        const { email, password } = body;
        if (!email || !password) return error(res, 'Email and password required');

        const user = auth.authenticateUser(email, password);
        if (!user) return error(res, 'Invalid email or password', 401);

        const token = auth.generateToken(user);
        const apiKeys = auth.listApiKeys(user.id);

        json(res, {
            token,
            user: {
                id: user.id,
                email: user.email,
                displayName: user.displayName
            },
            apiKeys
        });
    });

    get('GET', '/api/auth/me', async (req, res) => {
        const session = requireAuth(req);
        if (!session) return error(res, 'Unauthorized', 401);

        const user = auth.findUserById(session.userId);
        if (!user) return error(res, 'User not found', 404);

        json(res, { user });
    });

    // ====== API Key Routes ======

    get('GET', '/api/api-keys', async (req, res) => {
        const session = requireAuth(req);
        if (!session) return error(res, 'Unauthorized', 401);

        const keys = auth.listApiKeys(session.userId);
        json(res, { apiKeys: keys });
    });

    post('POST', '/api/api-keys', async (req, res) => {
        const session = requireAuth(req);
        if (!session) return error(res, 'Unauthorized', 401);

        const body = await parseBody(req);
        const apiKey = auth.createApiKey(session.userId, body.name);
        json(res, { apiKey }, 201);
    });

    post('POST', '/api/api-keys/:id/revoke', async (req, res) => {
        const session = requireAuth(req);
        if (!session) return error(res, 'Unauthorized', 401);

        // 从 URL 中提取 id
        const id = req.url.split('/').filter(Boolean).pop();
        const result = auth.revokeApiKey(id, session.userId);
        if (result.changes === 0) return error(res, 'API key not found', 404);
        json(res, { success: true });
    });

    // ====== Browser Routes ======

    get('GET', '/api/browsers', async (req, res) => {
        const session = requireAuth(req);
        if (!session) return error(res, 'Unauthorized', 401);

        const browsers = [];
        for (const pluginWs of pluginConnections) {
            if (pluginWs.readyState !== WebSocket.OPEN) continue;
            // 只返回属于当前用户的 plugin
            if (pluginWs.userId !== session.userId) continue;

            const ns = getNamespace(pluginWs);
            browsers.push({
                pluginId: pluginWs.pluginId,
                name: pluginWs.pluginName || 'My Browser',
                targets: ns.cachedTargets.length,
                connected: true,
                connectedAt: pluginWs.connectedAt,
                webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/${pluginWs.pluginId}`,
                // 给 web UI 用的直接连接地址
                cdpHttpUrl: `https://${req.headers.host}/json/version/${pluginWs.pluginId}`
            });
        }

        json(res, { browsers });
    });

    // ====== 返回路由处理函数 ======

    return async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://localhost`);

        for (const route of routes) {
            if (route.method !== req.method) continue;

            // 简单的路径匹配（支持 :id 占位符）
            const routeParts = route.path.split('/').filter(Boolean);
            const urlParts = url.pathname.split('/').filter(Boolean);

            if (routeParts.length !== urlParts.length) continue;

            let match = true;
            const params = {};
            for (let i = 0; i < routeParts.length; i++) {
                if (routeParts[i].startsWith(':')) {
                    params[routeParts[i].slice(1)] = urlParts[i];
                } else if (routeParts[i] !== urlParts[i]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                req.params = params;
                return route.handler(req, res);
            }
        }

        json(res, { error: 'Not found' }, 404);
    };
}

module.exports = { createRouter };
