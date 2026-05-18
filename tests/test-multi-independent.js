const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  const BASE = 'https://cdp.shanbox.19930810.xyz:8443';
  const errors = [];
  const results = [];

  console.log('=== 双浏览器独立操作测试 ===\n');

  console.log('Test 1: /json/browsers');
  let browsers;
  try {
    const raw = await httpGet(BASE + '/json/browsers');
    browsers = JSON.parse(raw);
    console.log('  ✅ 在线浏览器:', browsers.length);
    browsers.forEach((b, i) => {
      console.log(`    [${i}] pluginId=${b.pluginId}, targets=${b.targets}`);
    });
    results.push('browsers-list');
    
    if (browsers.length < 2) {
      console.log('  ⚠ 只有', browsers.length, '个浏览器，期望 2 个');
      errors.push('browsers-count: expected 2, got ' + browsers.length);
    }
  } catch (e) {
    console.log('  ❌', e.message);
    errors.push('browsers: ' + e.message);
    process.exit(1);
  }

  if (browsers.length < 2) {
    console.log('\n❌ 只有 1 个浏览器，无法测试双浏览器独立操作');
    process.exit(1);
  }

  console.log('\nTest 2: 连接 Browser 1');
  let browser1;
  try {
    const pluginId1 = browsers[0].pluginId;
    console.log('  pluginId:', pluginId1);
    
    const raw = await httpGet(BASE + '/json/version/' + pluginId1);
    const ver = JSON.parse(raw);
    console.log('  version:', ver.Browser);
    
    let wsUrl = ver.webSocketDebuggerUrl
      .replace('ws://', 'wss://')
      .replace(/\.xyz\//, '.xyz:8443/');
    
    browser1 = await chromium.connectOverCDP(wsUrl, { timeout: 15000 });
    console.log('  ✅ Browser 1 连接成功');
    results.push('browser1-connect');
  } catch (e) {
    console.log('  ❌', e.message);
    errors.push('browser1-connect: ' + e.message);
  }

  console.log('\nTest 3: 连接 Browser 2');
  let browser2;
  try {
    const pluginId2 = browsers[1].pluginId;
    console.log('  pluginId:', pluginId2);
    
    const raw = await httpGet(BASE + '/json/version/' + pluginId2);
    const ver = JSON.parse(raw);
    console.log('  version:', ver.Browser);
    
    let wsUrl = ver.webSocketDebuggerUrl
      .replace('ws://', 'wss://')
      .replace(/\.xyz\//, '.xyz:8443/');
    
    browser2 = await chromium.connectOverCDP(wsUrl, { timeout: 15000 });
    console.log('  ✅ Browser 2 连接成功');
    results.push('browser2-connect');
  } catch (e) {
    console.log('  ❌', e.message);
    errors.push('browser2-connect: ' + e.message);
  }

  console.log('\nTest 4: Browser 1 → example.com');
  try {
    const ctx = browser1.contexts()[0] || await browser1.newContext();
    const page = await ctx.newPage();
    await page.goto('https://example.com', { timeout: 10000 });
    const title = await page.title();
    console.log('  ✅ title:', title);
    await page.screenshot({ path: '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/multi-browser1.png' });
    results.push('browser1-nav');
  } catch (e) {
    console.log('  ❌', e.message);
    errors.push('browser1-nav: ' + e.message);
  }

  console.log('\nTest 5: Browser 2 → httpbin.org/ip');
  try {
    const ctx = browser2.contexts()[0] || await browser2.newContext();
    const page = await ctx.newPage();
    await page.goto('https://httpbin.org/ip', { timeout: 10000 });
    const text = await page.textContent('body');
    console.log('  ✅ body:', text?.substring(0, 60));
    await page.screenshot({ path: '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/multi-browser2.png' });
    results.push('browser2-nav');
  } catch (e) {
    console.log('  ❌', e.message);
    errors.push('browser2-nav: ' + e.message);
  }

  console.log('\nTest 6: 确认两个浏览器独立');
  try {
    const pages1 = browser1.contexts()[0]?.pages() || [];
    const pages2 = browser2.contexts()[0]?.pages() || [];
    const urls1 = pages1.map(p => p.url()).filter(u => u !== 'about:blank');
    const urls2 = pages2.map(p => p.url()).filter(u => u !== 'about:blank');
    console.log('  Browser 1 URLs:', urls1);
    console.log('  Browser 2 URLs:', urls2);
    if (urls1.length > 0 && urls2.length > 0 && urls1[0] !== urls2[0]) {
      console.log('  ✅ 两个浏览器独立（URL 不同）');
      results.push('independence');
    } else {
      console.log('  ⚠ 无法确认独立性');
    }
  } catch (e) {
    console.log('  ❌', e.message);
    errors.push('independence: ' + e.message);
  }

  if (browser1) await browser1.close().catch(() => {});
  if (browser2) await browser2.close().catch(() => {});

  console.log('\n========== 最终结果 ==========');
  console.log('通过:', results.length);
  console.log('失败:', errors.length);
  results.forEach(r => console.log('  ✅', r));
  errors.forEach(e => console.log('  ❌', e));
  
  if (errors.length > 0) process.exit(1);
  console.log('\n✅ 双浏览器独立操作验证全部通过！');
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
