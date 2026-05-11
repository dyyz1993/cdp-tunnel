#!/usr/bin/env node
'use strict';

/**
 * Test: Playwright connects to CDP Tunnel on port 9221
 * 
 * Tests standard Playwright operations through CDP Tunnel.
 */

const { chromium } = require('playwright');

async function test() {
  console.log('=== Playwright on Port 9221 Test ===\n');

  // Connect via CDP
  console.log('1. Connecting to CDP Tunnel (http://localhost:9221)...');
  const browser = await chromium.connectOverCDP('http://localhost:9221', {
    timeout: 30000
  });
  console.log('   ✅ Connected');

  // Get contexts
  console.log('\n2. Getting contexts...');
  const contexts = browser.contexts();
  console.log(`   ✅ ${contexts.length} context(s)`);
  
  const defaultContext = contexts[0];
  
  // Get existing pages
  console.log('\n3. Getting existing pages...');
  const existingPages = defaultContext.pages();
  console.log(`   ✅ ${existingPages.length} existing page(s)`);
  existingPages.forEach((p, i) => {
    console.log(`      Page ${i + 1}: ${p.url()}`);
  });

  // Create new page
  console.log('\n4. Creating new page...');
  const page = await defaultContext.newPage();
  console.log('   ✅ Page created');

  // Navigate
  console.log('\n5. Navigating to https://example.com...');
  await page.goto('https://example.com', { timeout: 10000 });
  console.log(`   ✅ Navigated to: ${page.url()}`);

  // Get title
  console.log('\n6. Getting title...');
  const title = await page.title();
  console.log(`   ✅ Title: "${title}"`);

  // Evaluate JavaScript
  console.log('\n7. Evaluating JavaScript...');
  const result = await page.evaluate(() => {
    return {
      url: window.location.href,
      title: document.title
    };
  });
  console.log(`   ✅ Eval result: ${JSON.stringify(result)}`);

  // Screenshot
  console.log('\n8. Taking screenshot...');
  await page.screenshot({ path: '/tmp/test-9221-screenshot.png' });
  console.log('   ✅ Screenshot saved to /tmp/test-9221-screenshot.png');

  // Create second page
  console.log('\n9. Creating second page...');
  const page2 = await defaultContext.newPage();
  await page2.goto('https://example.org', { timeout: 10000 });
  console.log(`   ✅ Page 2: ${page2.url()}`);

  // Close pages
  console.log('\n10. Closing pages...');
  await page.close();
  await page2.close();
  console.log('   ✅ Pages closed');

  // Close browser
  console.log('\n11. Closing browser...');
  await browser.close();
  console.log('   ✅ Browser closed');

  console.log('\n=== ALL TESTS PASSED ===\n');
}

test().catch(err => {
  console.error('❌ TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
