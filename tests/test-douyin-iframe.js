const { chromium } = require('playwright');

const SERVER_URL = process.env.CDP_SERVER || 'http://localhost:9221';
const DOUYIN_URL = 'https://www.douyin.com/user/MS4wLjABAAAAnKeRN8QUgooS1pPRqOf_N_jnuztzUyocl0_vUndQFJs?modal_id=7635666432337351530';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== Douyin IFrame Disconnect Test ===');
  console.log(`Server: ${SERVER_URL}\n`);

  let browser;
  try {
    console.log('[1] Connecting to CDP tunnel...');
    browser = await chromium.connectOverCDP(SERVER_URL, { timeout: 15000 });
    console.log('[1] Connected!\n');

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    console.log('[2] Navigating to Douyin page...');
    await page.goto(DOUYIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[2] Page loaded: ${page.url()}\n`);

    await sleep(3000);
    console.log('[3] Waiting for page to fully render...');
    await sleep(2000);

    // Check frame tree first
    console.log('[4] Checking frame tree...');
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const frameTree = await cdpSession.send('Page.getFrameTree');

      function printFrame(tree, indent) {
        if (!tree || !tree.frame) return;
        const pad = '  '.repeat(indent);
        console.log(`${pad}Frame: id=${tree.frame.id} url=${(tree.frame.url || '').substring(0, 80)}`);
        if (tree.childFrames) {
          for (const child of tree.childFrames) printFrame(child, indent + 1);
        }
      }
      printFrame(frameTree.frameTree, 0);
      await cdpSession.detach();
    } catch (e) {
      console.error('[4] Frame tree error:', e.message);
    }
    console.log('');

    // Try to find and click the entry button
    // The button has data-popupid attribute and contains an SVG
    console.log('[5] Looking for the entry button...');
    const selectors = [
      '[data-popupid]',
      'svg.wNbQukcA',
      '.r68hW_1W',
    ];

    let clicked = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        const count = await el.count();
        if (count > 0) {
          console.log(`[5] Found element with selector: ${sel}`);
          await el.click({ timeout: 5000 });
          console.log(`[5] Clicked!`);
          clicked = true;
          break;
        }
      } catch (e) {
        console.log(`[5] Selector ${sel}: ${e.message.substring(0, 80)}`);
      }
    }

    if (!clicked) {
      console.log('[5] Could not find entry button with known selectors, trying to list clickable elements...');
      const buttons = await page.$$eval('[data-popupid]', els => els.map(e => ({
        tag: e.tagName,
        popupid: e.getAttribute('data-popupid'),
        html: e.innerHTML.substring(0, 100)
      })));
      console.log('[5] Elements with data-popupid:', JSON.stringify(buttons, null, 2));
    }

    await sleep(3000);

    // Check frame tree again after click
    console.log('\n[6] Checking frame tree AFTER click...');
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const frameTree = await cdpSession.send('Page.getFrameTree');
      printFrameTree(frameTree.frameTree, 0);
      await cdpSession.detach();
    } catch (e) {
      console.error('[6] Frame tree error:', e.message);
    }

    // List all iframes on the page
    console.log('\n[7] Listing all iframes...');
    const iframes = await page.$$eval('iframe', els => els.map(e => ({
      id: e.id,
      src: e.src || e.getAttribute('srcdoc')?.substring(0, 50) || '(empty)',
      className: e.className,
      visible: e.offsetParent !== null
    })));
    console.log('[7] Iframes found:', JSON.stringify(iframes, null, 2));

    // Try to find and interact with iframe input
    console.log('\n[8] Trying to find input in iframes...');
    const frames = page.frames();
    console.log(`[8] Total frames: ${frames.length}`);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      console.log(`[8] Frame ${i}: url=${frame.url().substring(0, 80)} name=${frame.name()}`);

      if (frame === page.mainFrame()) continue;

      try {
        const inputs = await frame.locator('input, textarea').count();
        console.log(`[8]   Found ${inputs} input/textarea elements`);

        if (inputs > 0) {
          console.log(`[8]   Attempting to click first input in frame ${i}...`);
          const input = frame.locator('input, textarea').first();
          await input.click({ timeout: 5000 });
          console.log(`[8]   CLICK SUCCEEDED - no disconnect!`);

          await sleep(1000);
          await input.fill('test input');
          console.log(`[8]   FILL SUCCEEDED`);
        }
      } catch (e) {
        console.error(`[8]   Frame ${i} error: ${e.message.substring(0, 120)}`);
      }
    }

    console.log('\n=== Test completed - Playwright did NOT disconnect ===');

  } catch (e) {
    console.error('\n!!! FATAL ERROR - Possible disconnect !!!');
    console.error('Error:', e.message);
    console.error('This might indicate Playwright disconnected');
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('\nBrowser closed normally');
      } catch (e) {
        console.error('\nBrowser close FAILED:', e.message);
        console.error('This confirms Playwright disconnected');
      }
    }
  }
}

function printFrameTree(tree, indent) {
  if (!tree || !tree.frame) return;
  const pad = '  '.repeat(indent);
  console.log(`${pad}Frame: id=${tree.frame.id} url=${(tree.frame.url || '').substring(0, 80)}`);
  if (tree.childFrames) {
    for (const child of tree.childFrames) printFrameTree(child, indent + 1);
  }
}

main().catch(e => {
  console.error('UNHANDLED:', e);
  process.exit(1);
});
