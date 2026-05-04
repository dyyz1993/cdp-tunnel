const { chromium } = require('playwright');

const SERVER_URL = process.env.CDP_SERVER || 'http://localhost:9221';
const TEST_PAGE = `file://${__dirname}/iframe-test-page.html`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== IFrame Debug Test ===');
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Test page: ${TEST_PAGE}\n`);

  let browser;
  try {
    console.log('[1] Connecting to CDP tunnel...');
    browser = await chromium.connectOverCDP(SERVER_URL, {
      timeout: 10000
    });
    console.log('[1] Connected!\n');

    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('No default context found');
    }

    const pages = context.pages();
    let page;
    if (pages.length > 0) {
      page = pages[0];
      console.log(`[2] Using existing page: ${page.url()}`);
    } else {
      page = await context.newPage();
      console.log('[2] Created new page');
    }

    console.log(`[2] Navigating to test page...`);
    await page.goto(TEST_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`[2] Page loaded: ${page.url()}\n`);

    // --- Test 1: Main page input ---
    console.log('[Test 1] Main page input...');
    try {
      await page.fill('#main-input-1', 'Hello from main');
      const val1 = await page.inputValue('#main-input-1');
      console.log(`[Test 1] OK - value: "${val1}"\n`);
    } catch (e) {
      console.error(`[Test 1] FAIL: ${e.message}\n`);
    }

    // --- Test 2: Main page button ---
    console.log('[Test 2] Main page button click...');
    try {
      await page.click('#main-btn');
      await sleep(500);
      const status = await page.textContent('#status');
      console.log(`[Test 2] OK - status: "${status}"\n`);
    } catch (e) {
      console.error(`[Test 2] FAIL: ${e.message}\n`);
    }

    // --- Test 3: Same-origin iframe ---
    console.log('[Test 3] Same-origin iframe input...');
    try {
      const frame = page.frameLocator('#same-origin-iframe');
      const input = frame.locator('#iframe-input-1');
      await input.fill('Hello from iframe');
      const val = await input.inputValue();
      console.log(`[Test 3] OK - value: "${val}"\n`);
    } catch (e) {
      console.error(`[Test 3] FAIL: ${e.message}\n`);
    }

    // --- Test 4: Same-origin iframe button ---
    console.log('[Test 4] Same-origin iframe button click...');
    try {
      const frame = page.frameLocator('#same-origin-iframe');
      await frame.locator('#iframe-btn').click();
      await sleep(500);
      const result = await frame.locator('#iframe-result').textContent();
      console.log(`[Test 4] OK - result: "${result}"\n`);
    } catch (e) {
      console.error(`[Test 4] FAIL: ${e.message}\n`);
    }

    // --- Test 5: Cross-origin iframe (Wikipedia) ---
    console.log('[Test 5] Cross-origin iframe (Wikipedia)...');
    try {
      const frame = page.frameLocator('#cross-origin-iframe');
      // Just try to access the frame - this will likely fail
      const title = await frame.locator('h1').first().textContent({ timeout: 5000 });
      console.log(`[Test 5] OK - title: "${title}"\n`);
    } catch (e) {
      console.error(`[Test 5] FAIL (expected): ${e.message}\n`);
    }

    // --- Test 6: Nested iframe ---
    console.log('[Test 6] Nested iframe (level 1 input)...');
    try {
      const frame = page.frameLocator('#nested-iframe');
      await frame.locator('#l1-input').fill('Level 1');
      const val = await frame.locator('#l1-input').inputValue();
      console.log(`[Test 6] OK - value: "${val}"\n`);
    } catch (e) {
      console.error(`[Test 6] FAIL: ${e.message}\n`);
    }

    // --- Test 7: Nested iframe level 2 ---
    console.log('[Test 7] Nested iframe (level 2 input)...');
    try {
      const frame = page.frameLocator('#nested-iframe').frameLocator('#nested-inner');
      await frame.locator('#l2-input').fill('Level 2');
      const val = await frame.locator('#l2-input').inputValue();
      console.log(`[Test 7] OK - value: "${val}"\n`);
    } catch (e) {
      console.error(`[Test 7] FAIL: ${e.message}\n`);
    }

    // --- Test 8: Dynamic iframe ---
    console.log('[Test 8] Dynamic iframe...');
    try {
      await page.click('#create-iframe-btn');
      await sleep(1000);
      const frame = page.frameLocator('#dynamic-iframe');
      await frame.locator('#dyn-input').fill('Dynamic!');
      const val = await frame.locator('#dyn-input').inputValue();
      console.log(`[Test 8] OK - value: "${val}"\n`);
    } catch (e) {
      console.error(`[Test 8] FAIL: ${e.message}\n`);
    }

    // --- Test 9: Page.getFrameTree via CDP directly ---
    console.log('[Test 9] CDP Page.getFrameTree...');
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const frameTree = await cdpSession.send('Page.getFrameTree');
      console.log(`[Test 9] Frame tree:`);
      printFrameTree(frameTree.frameTree, 0);
      await cdpSession.detach();
      console.log('');
    } catch (e) {
      console.error(`[Test 9] FAIL: ${e.message}\n`);
    }

    // --- Test 10: Target.setAutoAttach + Target.attachedToTarget ---
    console.log('[Test 10] CDP Target.setAutoAttach + iframe sessions...');
    try {
      const cdpSession = await page.context().newCDPSession(page);

      let attachedEventCount = 0;
      cdpSession.on('Target.attachedToTarget', (event) => {
        attachedEventCount++;
        console.log(`[Test 10] Target.attachedToTarget event #${attachedEventCount}:`);
        console.log(`  sessionId: ${event.sessionId}`);
        console.log(`  targetInfo.type: ${event.targetInfo?.type}`);
        console.log(`  targetInfo.targetId: ${event.targetInfo?.targetId}`);
        console.log(`  targetInfo.url: ${event.targetInfo?.url}`);
        console.log(`  waitingForDebugger: ${event.waitingForDebugger}`);
      });

      cdpSession.on('Target.targetCreated', (event) => {
        console.log(`[Test 10] Target.targetCreated: type=${event.targetInfo?.type} targetId=${event.targetInfo?.targetId}`);
      });

      await cdpSession.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });

      await sleep(3000);

      console.log(`[Test 10] Total attachedToTarget events: ${attachedEventCount}`);
      await cdpSession.detach();
      console.log('');
    } catch (e) {
      console.error(`[Test 10] FAIL: ${e.message}\n`);
    }

    console.log('=== All tests completed ===');

  } catch (e) {
    console.error('Fatal error:', e);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function printFrameTree(tree, indent) {
  if (!tree || !tree.frame) return;
  const pad = '  '.repeat(indent);
  const frame = tree.frame;
  console.log(`${pad}Frame: id=${frame.id} url=${frame.url?.substring(0, 60)}`);
  if (tree.childFrames) {
    for (const child of tree.childFrames) {
      printFrameTree(child, indent + 1);
    }
  }
}

main().catch(console.error);
