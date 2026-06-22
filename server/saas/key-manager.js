#!/usr/bin/env node
'use strict';

/**
 * API Key 管理工具（手动创建/列出/删除 key）
 *
 * 一 key = 一浏览器。创建后把带 key 的地址给用户填进扩展。
 *
 * 用法：
 *   node server/saas/key-manager.js create [name]       创建 key
 *   node server/saas/key-manager.js list                列出所有 key
 *   node server/saas/key-manager.js revoke <keyId>      吊销 key
 *
 * 创建后会输出一个地址，格式：
 *   ws://localhost:9221/plugin?key=ak_xxxxxxxx
 * 上云后把 localhost 换成云域名。
 */

const auth = require('./auth');

const command = process.argv[2];
const arg = process.argv[3];

// 用来管理 key 的内置用户（绕过注册系统）
const BUILTIN_USER = { id: 'builtin-admin', email: 'admin@local', displayName: 'Admin' };

function ensureBuiltinUser() {
  const db = require('./db');
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(BUILTIN_USER.id);
  if (!existing) {
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(BUILTIN_USER.id, BUILTIN_USER.email, 'builtin-no-login', BUILTIN_USER.displayName);
  }
  return BUILTIN_USER;
}

function main() {
  try {
    if (command === 'create' || !command) {
      ensureBuiltinUser();
      const name = arg || ('browser-' + Date.now().toString(36));
      const keyInfo = auth.createApiKey(BUILTIN_USER.id, name);
      const port = process.env.PORT || 9221;
      const host = process.env.EXTERNAL_HOST || `localhost:${port}`;
      console.log('\n✅ Key 创建成功\n');
      console.log(`  Key ID:    ${keyInfo.keyId}`);
      console.log(`  名称:      ${name}`);
      console.log(`  Key:       ${keyInfo.key}`);
      console.log(`\n  扩展连接地址（填进扩展配置页）:`);
      console.log(`  \x1b[32mws://${host}/plugin?key=${keyInfo.key}\x1b[0m`);
      console.log(`\n  CDP 客户端连接地址:`);
      console.log(`  \x1b[32mws://${host}/client?key=${keyInfo.key}\x1b[0m`);
      console.log('');
      return;
    }

    if (command === 'list') {
      ensureBuiltinUser();
      const keys = auth.listApiKeys(BUILTIN_USER.id);
      if (keys.length === 0) {
        console.log('\n（没有 key，用 create 创建）\n');
        return;
      }
      console.log('\n=== API Keys ===\n');
      keys.forEach(k => {
        const status = k.active ? '✅' : '❌';
        const lastUsed = k.last_used_at ? k.last_used_at : '从未';
        console.log(`  ${status} ${k.name}`);
        console.log(`     ID: ${k.id}`);
        console.log(`     最后使用: ${lastUsed}`);
        console.log(`     创建: ${k.created_at}`);
        console.log('');
      });
      return;
    }

    if (command === 'revoke') {
      if (!arg) {
        console.log('用法: node key-manager.js revoke <keyId>');
        process.exit(1);
      }
      ensureBuiltinUser();
      auth.revokeApiKey(arg, BUILTIN_USER.id);
      console.log(`\n✅ Key ${arg} 已吊销\n`);
      return;
    }

    console.log('用法:');
    console.log('  node server/saas/key-manager.js create [name]    创建 key');
    console.log('  node server/saas/key-manager.js list             列出所有 key');
    console.log('  node server/saas/key-manager.js revoke <keyId>   吊销 key');
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}

main();
