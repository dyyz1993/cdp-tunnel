/**
 * E2E Test: CDP event deduplication for page connections
 *
 * Bug: When a client connects via /devtools/page/:targetId, CDP events
 * from the plugin are delivered TWICE because both the main plugin handler
 * (handlePluginConnection) and the page-specific pluginMessageHandler
 * (handlePageConnection) forward the same message to the same client.
 *
 * This test verifies:
 * 1. /devtools/page/:targetId receives each CDP event exactly ONCE
 * 2. /devtools/browser/ path is NOT regressed (also exactly ONCE)
 */

const WebSocket = require('ws');
const { startProxy, sleep, httpGet, cleanup, log } = require('./helpers');

const PORT = 19300;
const TARGET_ID = 'test-target-abc123';

let passed = 0;
let failed = 0;
let proxyProcess = null;

function assert(condition, testName, details = '') {
    if (condition) {
        console.log(`  ✅ PASS: ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${testName}`);
        if (details) console.log(`     ${details}`);
        failed++;
    }
}

async function runTest() {
    console.log('\n=== Test: CDP Event Deduplication ===\n');

    try {
        // Step 1: Start proxy server
        log('TEST', `Starting proxy on port ${PORT}...`);
        const started = await startProxy(PORT);
        if (!started) {
            console.error('❌ FAIL: Proxy server did not start');
            process.exit(1);
        }
        log('TEST', 'Proxy server started');

        // Step 2: Connect mock plugin
        log('TEST', 'Connecting mock plugin...');
        const pluginWs = new WebSocket(`ws://localhost:${PORT}/plugin`);
        await new Promise((resolve, reject) => {
            pluginWs.on('open', resolve);
            pluginWs.on('error', reject);
        });

        // Send plugin-hello to initialize
        pluginWs.send(JSON.stringify({ type: 'plugin-hello', version: '2.5.18' }));
        await sleep(300);
        log('TEST', 'Plugin connected and initialized');

        // Step 3: Test /devtools/page/:targetId path
        console.log('\n--- Test Case 1: /devtools/page/:targetId ---');
        const pageReceivedMessages = [];

        const pageWs = new WebSocket(`ws://localhost:${PORT}/devtools/page/${TARGET_ID}`);
        await new Promise((resolve, reject) => {
            pageWs.on('open', resolve);
            pageWs.on('error', reject);
        });
        log('TEST', `Page client connected to /devtools/page/${TARGET_ID}`);

        // Register message collector
        pageWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'Page.frameAttached') {
                    pageReceivedMessages.push(msg);
                    log('TEST', `  Page client received: Page.frameAttached (#${pageReceivedMessages.length})`);
                }
            } catch {}
        });

        // Wait for pairing to complete
        await sleep(300);

        // Step 4: Send CDP event from plugin
        const cdpEvent = {
            type: 'event',
            method: 'Page.frameAttached',
            params: { frameId: 'test-frame-1', parentFrameId: 'parent' }
        };
        log('TEST', 'Sending Page.frameAttached from plugin...');
        pluginWs.send(JSON.stringify(cdpEvent));

        // Wait for delivery (both immediate and delayed duplicates)
        await sleep(2000);

        // Step 5: Assert count
        const pageCount = pageReceivedMessages.length;
        assert(
            pageCount === 1,
            `/devtools/page/:targetId should receive exactly 1 event, got ${pageCount}`,
            `Expected: 1, Actual: ${pageCount} ${pageCount > 1 ? '← BUG: DUPLICATE DELIVERY!' : pageCount === 0 ? '← No events received' : ''}`
        );

        if (pageReceivedMessages.length > 0) {
            log('TEST', `  First message: ${JSON.stringify(pageReceivedMessages[0])}`);
        }
        if (pageReceivedMessages.length > 1) {
            log('TEST', `  Duplicate message: ${JSON.stringify(pageReceivedMessages[1])}`);
        }

        pageWs.close();
        await sleep(200);

        // Step 6: Test /devtools/browser/ path (no regression)
        console.log('\n--- Test Case 2: /devtools/browser/ (regression check) ---');
        const browserReceivedMessages = [];

        const browserWs = new WebSocket(`ws://localhost:${PORT}/devtools/browser/test-browser-id`);
        await new Promise((resolve, reject) => {
            browserWs.on('open', resolve);
            browserWs.on('error', reject);
        });
        log('TEST', 'Browser client connected to /devtools/browser/test-browser-id');

        browserWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'Page.frameAttached') {
                    browserReceivedMessages.push(msg);
                    log('TEST', `  Browser client received: Page.frameAttached (#${browserReceivedMessages.length})`);
                }
            } catch {}
        });

        // Wait for pairing
        await sleep(300);

        // Send the same event again
        log('TEST', 'Sending Page.frameAttached from plugin (browser test)...');
        pluginWs.send(JSON.stringify(cdpEvent));

        await sleep(2000);

        const browserCount = browserReceivedMessages.length;
        assert(
            browserCount === 1,
            `/devtools/browser/ should receive exactly 1 event, got ${browserCount}`,
            `Expected: 1, Actual: ${browserCount} ${browserCount > 1 ? '← REGRESSION!' : browserCount === 0 ? '← No events received' : ''}`
        );

        browserWs.close();

        // Step 7: Additional test - CDP response (id-based) should also not duplicate
        console.log('\n--- Test Case 3: CDP response dedup on /devtools/page/ ---');
        await sleep(200);

        const pageWs2 = new WebSocket(`ws://localhost:${PORT}/devtools/page/${TARGET_ID}-resp`);
        const responseMessages = [];
        await new Promise((resolve, reject) => {
            pageWs2.on('open', resolve);
            pageWs2.on('error', reject);
        });

        pageWs2.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === 42) {
                    responseMessages.push(msg);
                    log('TEST', `  Page client received response id=42 (#${responseMessages.length})`);
                }
            } catch {}
        });

        await sleep(300);

        const cdpResponse = {
            id: 42,
            result: { frameTree: { frame: { id: 'root' } } }
        };
        log('TEST', 'Sending CDP response (id=42) from plugin...');
        pluginWs.send(JSON.stringify(cdpResponse));

        await sleep(2000);

        const respCount = responseMessages.length;
        assert(
            respCount === 1,
            `/devtools/page/ CDP response should be delivered exactly once, got ${respCount}`,
            `Expected: 1, Actual: ${respCount}`
        );

        pageWs2.close();

        // Cleanup
        pluginWs.close();
        await sleep(200);

    } catch (err) {
        console.error(`\n❌ TEST ERROR: ${err.message}`);
        console.error(err.stack);
        failed++;
    } finally {
        await cleanup();
    }

    // Summary
    console.log('\n=== Test Summary ===');
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total:  ${passed + failed}`);

    if (failed > 0) {
        console.log('\n❌ OVERALL: FAILED');
        process.exit(1);
    } else {
        console.log('\n✅ OVERALL: PASSED');
        process.exit(0);
    }
}

runTest();
