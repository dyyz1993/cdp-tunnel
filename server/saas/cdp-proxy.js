/**
 * CDP 代理桥接
 * SaaS API 服务器通过此模块查询 CDP 代理的浏览器信息
 */
const http = require('http');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9221');

function cdpRequest(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://${CDP_HOST}:${CDP_PORT}${path}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(data); }
            });
        }).on('error', reject);
    });
}

async function getBrowsers(userId) {
    try {
        const browsers = await cdpRequest('/json/browsers');
        if (!Array.isArray(browsers)) return [];
        if (userId) {
            return browsers.filter(b => b.userId === userId);
        }
        return browsers;
    } catch (e) {
        console.error('[CDP] Failed to get browsers:', e.message);
        return [];
    }
}

module.exports = { getBrowsers, cdpRequest };
