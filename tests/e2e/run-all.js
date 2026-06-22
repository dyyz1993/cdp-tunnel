#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { execSync } = require('child_process');

const TESTS = [
  { file: 'test-default-page.js', name: 'Default Page (auto about:blank)', timeout: 120000, tier: 'core' },
  { file: 'test-strict-isolation.js', name: 'Strict Client Isolation', timeout: 120000, tier: 'core' },
  { file: 'test-no-user-tab-grab.js', name: 'User Tab Protection', timeout: 120000, tier: 'core' },
  { file: 'test-disconnect-cleanup.js', name: 'Disconnect Cleanup', timeout: 120000, tier: 'core' },
  { file: 'test-existing-pages.js', name: 'Existing Pages Isolation', timeout: 120000, tier: 'core' },
  { file: 'test-concurrent-clients.js', name: '3 Concurrent Clients', timeout: 120000, tier: 'core' },
  { file: 'test-many-pages.js', name: '25-Page Stress', timeout: 180000, tier: 'core' },
  { file: 'test-group-fixes.js', name: 'Group Naming + Cleanup', timeout: 120000, tier: 'core' },
  { file: 'test-custom-clientid.js', name: 'Custom clientId Path', timeout: 120000, tier: 'new' },
  { file: 'test-mid-operation-disconnect.js', name: 'Mid-Operation Disconnect', timeout: 120000, tier: 'new' },
  { file: 'test-rapid-reconnect.js', name: 'Rapid Reconnect Cycles', timeout: 120000, tier: 'new' },
  { file: 'test-network-cdp.js', name: 'Network CDP', timeout: 120000, tier: 'new' },
  { file: 'test-browser-close-hijack.js', name: 'Browser.close Hijack', timeout: 180000, tier: 'core' },
  { file: 'test-playwright-full.js', name: 'Full Playwright Lifecycle', timeout: 180000, tier: 'extended' },
  { file: 'test-single-group-per-client.js', name: 'Single Group Per Client', timeout: 180000, tier: 'core' },
  { file: 'test-concurrent-create-target.js', name: 'Concurrent createTarget Race', timeout: 180000, tier: 'core' },
  { file: 'test-real-concurrent.js', name: '3 Concurrent Playwright', timeout: 180000, tier: 'extended' },
  { file: 'test-real-playwright.js', name: 'Playwright Compatibility', timeout: 120000, tier: 'extended' },
  { file: 'test-group-root-fix.js', name: 'Group Root Fix', timeout: 180000, tier: 'new' },
  { file: 'test-rapid-reconnect-group.js', name: 'Rapid Reconnect Group Race', timeout: 180000, tier: 'core' },
  { file: 'test-multi-connection.js', name: 'Multi Connection', timeout: 300000, tier: 'new' },
  { file: 'test-takeover-mode.js', name: 'Takeover Mode', timeout: 300000, tier: 'new' },
  { file: 'test-no-escape.js', name: 'No Tab Escape', timeout: 300000, tier: 'core' },
  { file: 'test-input-delivery.js', name: 'Input Event Delivery (keyboard/mouse)', timeout: 180000, tier: 'core' },
  { file: 'test-port-isolation.js', name: 'Port Pool Isolation (v3.0)', timeout: 180000, tier: 'new' },
  { file: 'test-port-pool-full.js', name: 'Port Pool Full CDP Chain', timeout: 180000, tier: 'new' },
  { file: 'test-ab-compare.js', name: 'A/B Compare: Direct CDP vs Port Pool', timeout: 180000, tier: 'core' },
  { file: 'test-ab-gate.js', name: 'A/B Gate (提交必须通过)', timeout: 180000, tier: 'core' },
  { file: 'test-concurrent-pool.js', name: 'Concurrent Pool (xbrowser 5×6)', timeout: 300000, tier: 'core' },
  { file: 'test-long-connection.js', name: 'Long Connection Stability', timeout: 300000, tier: 'extended' },
  { file: 'test-user-tab-not-grouped.js', name: 'User Tab Not Grouped', timeout: 120000, tier: 'core' },
  { file: 'test-sw-keepalive.js', name: 'SW Keepalive + Reconnect', timeout: 180000, tier: 'new' },
  { file: 'test-cli-commands.js', name: 'CLI Commands', timeout: 30000, tier: 'core' },
  { file: 'test-api-key-auth.js', name: 'API Key Auth (REQUIRE_AUTH)', timeout: 120000, tier: 'core' },
  { file: 'test-multi-client-tab-switch.js', name: 'Multi-client Tab Switch', timeout: 120000, tier: 'core' },
  { file: 'test-page-connection-dedup.js', name: 'Page Connection Dedup', timeout: 120000, tier: 'core' },
  { file: 'test-residual-tabs-cleanup.js', name: 'Residual Tabs Cleanup', timeout: 120000, tier: 'core' },
  { file: 'test-tab-group-monitor-regroup.js', name: 'Tab Group Monitor Re-group', timeout: 120000, tier: 'new' },
  { file: 'test-user-tab-during-session.js', name: 'User Tab During Session', timeout: 120000, tier: 'core' },
  { file: 'test-real-upload.js', name: 'Real Upload', timeout: 180000, tier: 'extended' },
];

const SKIP_EXTENDED = process.env.SKIP_EXTENDED === '1' || process.env.CI === 'true';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()) : null;

function getTestsToRun() {
  let tests = TESTS;
  if (ONLY) {
    tests = tests.filter(t => ONLY.some(o => t.file.includes(o)));
  } else if (SKIP_EXTENDED) {
    tests = tests.filter(t => t.tier !== 'extended');
  }
  return tests;
}

function parseResults(output) {
  const results = { passed: 0, failed: 0 };
  const match = output.match(/=== RESULTS: (\d+) passed, (\d+) failed ===/);
  if (match) {
    results.passed = parseInt(match[1], 10);
    results.failed = parseInt(match[2], 10);
  }
  return results;
}

function runTest(test, index, total) {
  return new Promise((resolve) => {
    const filePath = path.resolve(__dirname, test.file);
    const label = `[${index + 1}/${total}] ${test.name}`;
    const startTime = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ▶ ${label}`);
    console.log(`${'─'.repeat(60)}`);

    const child = spawn(process.execPath, [filePath], {
      cwd: __dirname,
      env: {
        ...process.env,
        POOL_SIZE: '0',  // 测试时禁用端口池，避免端口冲突
        CHROME_PATH: process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium',
        CHROMIUM_FLAGS: '--headless=new',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const elapsed = Date.now() - startTime;
      resolve({
        ...test,
        status: 'TIMEOUT',
        elapsed,
        passed: 0,
        failed: 0,
        error: `Timed out after ${test.timeout / 1000}s`,
      });
    }, test.timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - startTime;
      const results = parseResults(stdout + stderr);

      let status;
      let error = null;
      if (code === 0 && results.failed === 0) {
        status = 'PASS';
      } else if (code !== 0) {
        status = 'FAIL';
        const errLines = stderr.trim().split('\n').slice(-3).join('\n');
        error = `exit=${code}${errLines ? ' — ' + errLines : ''}`;
      } else {
        status = 'FAIL';
        error = `${results.failed} sub-test(s) failed`;
      }

      resolve({
        ...test,
        status,
        elapsed,
        passed: results.passed,
        failed: results.failed,
        error,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ...test,
        status: 'ERROR',
        elapsed: Date.now() - startTime,
        passed: 0,
        failed: 0,
        error: err.message,
      });
    });
  });
}

function printSummary(results) {
  console.log('\n\n' + '═'.repeat(72));
  console.log('  CDP TUNNEL — REGRESSION TEST SUMMARY');
  console.log('═'.repeat(72));

  const tierOrder = { core: 0, new: 1, extended: 2 };
  const tierLabel = { core: 'CORE', new: 'NEW', extended: 'EXT' };

  for (const tier of ['core', 'new', 'extended']) {
    const tierResults = results.filter(r => r.tier === tier);
    if (tierResults.length === 0) continue;

    console.log(`\n  ┌─ ${tierLabel[tier]} TESTS ${'─'.repeat(56)}`);
    for (const r of tierResults) {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭' : '❌';
      const time = (r.elapsed / 1000).toFixed(1) + 's';
      const detail = r.status === 'PASS'
        ? `${r.passed} passed`
        : r.error || `${r.failed} failed`;
      console.log(`  │ ${icon} ${r.name.padEnd(35)} ${time.padStart(7)}  ${detail}`);
    }
    const tierIcon = tierResults.every(r => r.status === 'PASS') ? '✅' : '❌';
    const tierPass = tierResults.filter(r => r.status === 'PASS').length;
    console.log(`  └─ ${tierIcon} ${tierPass}/${tierResults.length} passed`);
  }

  const totalPassed = results.filter(r => r.status === 'PASS').length;
  const totalFailed = results.filter(r => r.status === 'FAIL' || r.status === 'ERROR' || r.status === 'TIMEOUT').length;
  const totalSubPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalSubFailed = results.reduce((s, r) => s + r.failed, 0);

  console.log('\n' + '─'.repeat(72));
  console.log(`  Files:  ${totalPassed} passed / ${totalFailed} failed / ${results.length} total`);
  console.log(`  Checks: ${totalSubPassed} passed / ${totalSubFailed} failed`);
  console.log('═'.repeat(72));

  if (totalFailed > 0) {
    console.log('\n  Failed tests:');
    for (const r of results.filter(r => r.status !== 'PASS')) {
      console.log(`    ❌ ${r.file}: ${r.error}`);
    }
  }

  return totalFailed === 0;
}

async function main() {
  const tests = getTestsToRun();

  console.log('═'.repeat(72));
  console.log('  CDP TUNNEL — FULL REGRESSION TEST RUNNER');
  console.log('═'.repeat(72));
  console.log(`  Tests:    ${tests.length}`);
  console.log(`  Browser:  ${process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium'}`);
  console.log(`  Mode:     --headless=new`);
  console.log(`  Tiers:    ${SKIP_EXTENDED ? 'core + new (extended skipped)' : 'core + new + extended'}`);
  console.log(`  Started:  ${new Date().toISOString()}`);
  console.log('═'.repeat(72));

  const results = [];
  const globalStart = Date.now();

  for (let i = 0; i < tests.length; i++) {
    const result = await runTest(tests[i], i, tests.length);
    results.push(result);

    const icon = result.status === 'PASS' ? '✅' : '❌';
    const time = (result.elapsed / 1000).toFixed(1);
    console.log(`\n  ${icon} ${result.name} — ${result.status} (${time}s)`);
  }

  const globalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
  const allPass = printSummary(results);

  const totalPassed = results.filter(r => r.status === 'PASS').length;
  const totalFailed = results.filter(r => r.status === 'FAIL' || r.status === 'ERROR' || r.status === 'TIMEOUT').length;
  const totalSubPassed = results.reduce((s, r) => s + r.passed, 0);

  console.log(`\n  Total time: ${globalElapsed}s`);
  console.log(`  Finished:   ${new Date().toISOString()}\n`);

  if (allPass) {
    console.log(`\n✅ ✅ ✅  ALL ${results.length} TESTS PASSED (${totalSubPassed} checks)  ✅ ✅ ✅\n`);
    try {
      execSync(`osascript -e 'display notification "All ${results.length} tests passed!" with title "cdp-tunnel" sound name "Glass"'`, { stdio: 'ignore' });
    } catch {}
  } else {
    console.log(`\n❌ ❌ ❌  ${totalFailed}/${results.length} TESTS FAILED  ❌ ❌ ❌\n`);
    try {
      execSync(`osascript -e 'display notification "${totalFailed} tests failed!" with title "cdp-tunnel" sound name "Basso"'`, { stdio: 'ignore' });
    } catch {}
  }

  process.exit(allPass ? 0 : 1);
}

process.on('SIGINT', () => {
  console.log('\n  Interrupted — exiting.');
  process.exit(130);
});

main();
