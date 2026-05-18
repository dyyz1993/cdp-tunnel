/**
 * 认证工具 — JWT + API Key + 密码哈希
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// JWT 密钥（生产环境应通过环境变量配置）
const JWT_SECRET = process.env.JWT_SECRET || 'cdp-tunnel-saas-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '24h';

// ====== 密码管理 ======

function hashPassword(password) {
    return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
}

// ====== JWT 管理 ======

function generateToken(user) {
    return jwt.sign(
        { userId: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// ====== 用户管理 ======

function createUser(email, password, displayName) {
    const id = uuidv4();
    const passwordHash = hashPassword(password);
    db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name)
        VALUES (?, ?, ?, ?)
    `).run(id, email, passwordHash, displayName || email.split('@')[0]);
    return { id, email, displayName: displayName || email.split('@')[0] };
}

function findUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function findUserById(id) {
    return db.prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?').get(id);
}

function authenticateUser(email, password) {
    const user = findUserByEmail(email);
    if (!user) return null;
    if (!verifyPassword(password, user.password_hash)) return null;
    return { id: user.id, email: user.email, displayName: user.display_name };
}

// ====== API Key 管理 ======

function generateApiKey() {
    return 'cdp_' + uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
}

function createApiKey(userId, name) {
    const id = uuidv4();
    const key = generateApiKey();
    db.prepare(`
        INSERT INTO api_keys (id, user_id, key, name)
        VALUES (?, ?, ?, ?)
    `).run(id, userId, key, name || 'default');
    return { id, key, name: name || 'default' };
}

function validateApiKey(key) {
    const apiKey = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1').get(key);
    if (!apiKey) return null;
    // 更新最后使用时间
    db.prepare('UPDATE api_keys SET last_used_at = datetime("now") WHERE id = ?').run(apiKey.id);
    return { userId: apiKey.user_id, keyId: apiKey.id, keyName: apiKey.name };
}

function listApiKeys(userId) {
    return db.prepare('SELECT id, name, active, created_at, last_used_at FROM api_keys WHERE user_id = ?').all(userId);
}

function revokeApiKey(keyId, userId) {
    return db.prepare('UPDATE api_keys SET active = 0 WHERE id = ? AND user_id = ?').run(keyId, userId);
}

// ====== 初始化种子用户（仅开发环境） ======

function seedAdminUser() {
    const existing = findUserByEmail('admin@cdp-tunnel.dev');
    if (!existing) {
        const user = createUser('admin@cdp-tunnel.dev', 'admin123', 'Admin');
        const apiKey = createApiKey(user.id, 'default');
        console.log('[SAAS] Seed admin user created');
        console.log('[SAAS]   Email: admin@cdp-tunnel.dev');
        console.log('[SAAS]   Password: admin123');
        console.log('[SAAS]   API Key:', apiKey.key);
    }
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    createUser,
    findUserByEmail,
    findUserById,
    authenticateUser,
    createApiKey,
    validateApiKey,
    listApiKeys,
    revokeApiKey,
    seedAdminUser
};
