#!/usr/bin/env node
'use strict';

/**
 * Test: User-opened tab from CDP tab should NOT be in CDP group
 *
 * 1. Setup: patch config, start proxy, launch Chrome, wait for extension
 * 2. Connect CDP client
 * 3. Create a CDP tab via Target.createTarget
 * 4. Verify the CDP tab is grouped (Tab.getGroupInfo → groupId > -1)
 * 5. Call Tab.simulateUserOpen to create a user tab from the CDP tab
 * 6. Wait 3 seconds
 * 7. Check the NEW tab's group via Tab.getTabGroup
 * 8. Assert: user's new tab should NOT be in the CDP group (groupId === -1)
 *    — THIS IS EXPECTED TO FAIL (red light)
 */

const {
  log, sleep, sendCDP, httpGet,
  startProxy, startBrowser,
  waitForExtension, connectCDP, cleanup,
  EXTENSION_SRC
} = require('./helpers');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(EXTENSION_SRC, 'utils', 'config.js');
let _configOriginal = null;

function patchConfig(port) {
  _configOriginal = fs.readFileSync(CONFIG_FILE, 'utf8');
  fs.writeFileSync(CONFIG_FILE, _configOriginal.replace(/WS_URL:\s*'[^']*'/, `WS_URL: 'ws://localhost:${port}/plugin'`));
}
function restoreConfig() {
  if (_configOriginal) { fs.writeFileSync(CONFIG_FILE, _configOriginal); _configOriginal = null; }
}

const PORT = 10000 + Math.floor(Math.random() * 50000);

async function runTest() {
  console.log(`\n=== Test: User Tab Not Grouped (port ${PORT}) ===\n`);
  let passed = 0;
  let failed = 0;

  try {
    patchConfig(PORT);
    log('SETUP', 'Starting proxy...');
    if (!await startProxy(PORT)) throw new Error('Proxy failed to start');
    log('SETUP', 'Proxy ready');

    log('SETUP', 'Launching browser...');
    await startBrowser();
    if (!await waitForExtension(PORT)) throw new Error('Extension failed to connect');
    log('SETUP', 'Extension connected');

    const ws = await connectCDP(PORT);
    log('CDP', 'Connected to CDP');

    await sendCDP(ws, 'Target.setDiscoverTargets', { discover: true });
    await sleep(1000);

    log('CDP', 'Creating CDP tab via Target.createTarget...');
    const createResult = await sendCDP(ws, 'Target.createTarget', { url: 'about:blank' });
    const targetId = createResult.targetId;
    log('CDP', `Created CDP tab: targetId=${targetId}`);

    log('WAIT', 'Waiting 5s for group assignment...');
    await sleep(5000);

    log('CHECK', 'Verifying CDP tab is grouped...');
    const groupInfo = await sendCDP(ws, 'Tab.getGroupInfo');
    log('CHECK', `CDP tab group info: groupId=${groupInfo.groupId}, cachedGroupId=${groupInfo.cachedGroupId}`);

    if (groupInfo.groupId > -1) {
      log('PASS', `PASS 1: CDP tab is grouped (groupId=${groupInfo.groupId})`);
      passed++;
    } else {
      log('FAIL', `PASS 1 FAILED: CDP tab is NOT grouped (groupId=${groupInfo.groupId})`);
      failed++;
    }

    const cdpGroupId = groupInfo.groupId;

    log('CDP', 'Calling Tab.simulateUserOpen...');
    const simResult = await sendCDP(ws, 'Tab.simulateUserOpen');
    log('CDP', `simulateUserOpen result: ${JSON.stringify(simResult)}`);

    if (!simResult.success) {
      log('FAIL', `Tab.simulateUserOpen failed: ${simResult.error}`);
      failed++;
      ws.close();
      return;
    }

    const newTabId = simResult.newTabId;
    const openerTabId = simResult.openerTabId;
    log('CDP', `New user tab: tabId=${newTabId}, openerTabId=${openerTabId}`);

    log('WAIT', 'Waiting 8s (let monitor run too)...');
    await sleep(8000);

    log('CHECK', `Checking new tab group status (tabId=${newTabId})...`);
    const newTabGroup = await sendCDP(ws, 'Tab.getTabGroup', { tabId: newTabId });
    log('CHECK', `New tab group info: ${JSON.stringify(newTabGroup)}`);

    if (newTabGroup.groupId === -1 || newTabGroup.groupId !== cdpGroupId) {
      log('PASS', `PASS 2: User's new tab is NOT in CDP group (groupId=${newTabGroup.groupId}, CDP group=${cdpGroupId})`);
      passed++;
    } else {
      log('FAIL', `PASS 2 FAILED (EXPECTED RED): User's new tab IS in CDP group (groupId=${newTabGroup.groupId} === ${cdpGroupId})`);
      failed++;
    }

    ws.close();
  } catch (err) {
    console.error('\nFATAL:', err.message);
    failed++;
  } finally {
    restoreConfig();
    await cleanup();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTest();
