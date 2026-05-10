#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const CLI_PATH = path.resolve(__dirname, '../../cli/index.js');

let passed = 0;
let failed = 0;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function test(name, fn) {
  try {
    fn();
    log('PASS', `✅ ${name}`);
    passed++;
  } catch (err) {
    log('FAIL', `❌ ${name}: ${err.message}`);
    failed++;
  }
}

test('--help exits cleanly', () => {
  const output = execSync(`node "${CLI_PATH}" --help`, { encoding: 'utf8', timeout: 10000 });
  if (!output.includes('start')) throw new Error('Missing start command');
  if (!output.includes('常用命令')) throw new Error('Missing usage examples');
});

test('start --help shows --auto-restart', () => {
  const output = execSync(`node "${CLI_PATH}" start --help`, { encoding: 'utf8', timeout: 10000 });
  if (!output.includes('auto-restart')) throw new Error('Missing --auto-restart option');
  if (!output.includes('watchdog')) throw new Error('Missing --watchdog option');
});

test('--version shows version', () => {
  const output = execSync(`node "${CLI_PATH}" --version`, { encoding: 'utf8', timeout: 10000 });
  if (!output.match(/\d+\.\d+\.\d+/)) throw new Error('Invalid version: ' + output.trim());
});

test('status exits cleanly', () => {
  const output = execSync(`node "${CLI_PATH}" status`, { encoding: 'utf8', timeout: 10000 });
  if (!output.includes('已停止') && !output.includes('运行中')) throw new Error('Missing status');
});

test('update command exits without hanging', () => {
  const start = Date.now();
  try {
    const output = execSync(`node "${CLI_PATH}" update`, { encoding: 'utf8', timeout: 30000 });
    const duration = Date.now() - start;
    log('INFO', `  Update completed in ${duration}ms: ${output.trim().split('\n').pop()}`);
  } catch (err) {
    const duration = Date.now() - start;
    if (duration > 25000) throw new Error('Update command hung for too long');
    log('INFO', `  Update exited in ${duration}ms (non-zero exit OK in CI)`);
  }
});

console.log('\n=== RESULTS ===');
console.log(`Passed: ${passed}, Failed: ${failed}`);
console.log('==============\n');
process.exit(failed > 0 ? 1 : 0);
