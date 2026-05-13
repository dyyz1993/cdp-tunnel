#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension-new', 'manifest.json'), 'utf8'));

const pkgVersion = pkg.version;
const manifestVersion = manifest.version;

if (pkgVersion !== manifestVersion) {
  console.error('版本不一致!');
  console.error(`  package.json:       ${pkgVersion}`);
  console.error(`  extension manifest: ${manifestVersion}`);
  console.error('请同步版本后重新提交。');
  process.exit(1);
}

console.log(`版本同步检查通过: v${pkgVersion}`);
