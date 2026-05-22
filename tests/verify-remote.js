const { chromium } = require('playwright');
const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  const CDP_URL = 'https://cdp.shanbox.19930810.xyz:8443';
  const errors = [];
  const results = [];

  console.log('Test 1: HTTP /json/version');
  try {
    const raw = await httpGet(CDP_URL + '/json/version');
    const ver = JSON.parse(raw);
    if (ver.Browser && ver.webSocketDebuggerUrl) {
      console.log('  ✅ PASS -', ver.Browser);
      results.push('json/version');
    } else {
      console.log('  ❌ FAIL - 缺少字段');
      errors.push('json/version: missing fields');
    }
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('json/version: ' + e.message);
  }

  console.log('Test 2: HTTP /json/list');
  try {
    const raw = await httpGet(CDP_URL + '/json/list');
    const list = JSON.parse(raw);
    console.log('  ✅ PASS - targets:', list.length);
    results.push('json/list');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('json/list: ' + e.message);
  }

  console.log('Test 3: Playwright connectOverCDP');
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 20000, wsEndpointParams: {} });
    console.log('  ✅ PASS - 连接成功');
    results.push('connectOverCDP');
  } catch (e) {
    console.log('  ❌ FAIL (try direct wsURL) -', e.message);
    try {
      const raw = await httpGet(CDP_URL + '/json/version');
      const ver = JSON.parse(raw);
      const wsUrlRaw = ver.webSocketDebuggerUrl;
      const browserId = wsUrlRaw.split('/').pop();
      const fixedWsUrl = 'wss://cdp.shanbox.19930810.xyz:8443/devtools/browser/' + browserId;
      console.log('  Retrying with fixed URL:', fixedWsUrl);
      browser = await chromium.connectOverCDP(fixedWsUrl, { timeout: 20000 });
      console.log('  ✅ PASS (via fixed wsURL) - 连接成功');
      results.push('connectOverCDP');
    } catch (e2) {
      console.log('  ❌ FAIL -', e2.message);
      errors.push('connectOverCDP: ' + e2.message);
      console.log('\n=== 最终结果 ===');
      console.log('通过:', results.length, '  失败:', errors.length);
      errors.forEach(e => console.log('  ❌', e));
      process.exit(1);
    }
  }

  console.log('Test 4: 获取 browser contexts');
  try {
    const contexts = browser.contexts();
    console.log('  ✅ PASS - contexts:', contexts.length);
    results.push('contexts');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('contexts: ' + e.message);
  }

  console.log('Test 5: 新建页面');
  let page;
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = await ctx.newPage();
    console.log('  ✅ PASS');
    results.push('newPage');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('newPage: ' + e.message);
  }

  console.log('Test 6: 导航到 example.com');
  try {
    await page.goto('https://example.com', { timeout: 15000 });
    const title = await page.title();
    console.log('  ✅ PASS - title:', title);
    results.push('goto');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('goto: ' + e.message);
  }

  console.log('Test 7: 页面交互 - 获取页面内容');
  try {
    const h1 = await page.textContent('h1');
    console.log('  ✅ PASS - h1:', h1);
    results.push('interaction');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('interaction: ' + e.message);
  }

  console.log('Test 8: 截图');
  try {
    await page.screenshot({ path: '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/verify-remote.png' });
    const fs = require('fs');
    const stat = fs.statSync('/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/verify-remote.png');
    console.log('  ✅ PASS - size:', Math.round(stat.size / 1024) + 'KB');
    results.push('screenshot');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('screenshot: ' + e.message);
  }

  console.log('Test 9: 执行 JavaScript');
  try {
    const result = await page.evaluate(() => document.querySelectorAll('a').length);
    console.log('  ✅ PASS - links:', result);
    results.push('evaluate');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('evaluate: ' + e.message);
  }

  console.log('Test 10: 百度搜索');
  try {
    await page.goto('https://www.baidu.com', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const kw = document.querySelector('#kw');
      if (kw) { kw.value = 'cdp-tunnel playwright'; kw.dispatchEvent(new Event('input', { bubbles: true })); }
      const su = document.querySelector('#su');
      if (su) su.click();
    });
    await page.waitForTimeout(3000);
    const title = await page.title();
    const url = page.url();
    console.log('  ✅ PASS - title:', title);
    results.push('baidu-search');
  } catch (e) {
    console.log('  ❌ FAIL -', e.message);
    errors.push('baidu-search: ' + e.message);
  }

  await browser.close().catch(() => {});

  console.log('\n========== 最终结果 ==========');
  console.log('通过:', results.length, '/ 10');
  console.log('失败:', errors.length);
  if (errors.length > 0) {
    console.log('\n失败项:');
    errors.forEach(e => console.log('  ❌', e));
  }
  console.log('\n通过项:');
  results.forEach(r => console.log('  ✅', r));

  if (errors.length > 0) process.exit(1);
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
