const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');

// Step 1: 登录获取 API Key
async function loginAndGetKey() {
  console.log('=== Step 1: 登录获取 API Key ===');
  const BASE = 'https://cdp.shanbox.19930810.xyz:8443';
  
  const loginRes = await httpsRequest('POST', '/api/auth/login', 
    { 'Content-Type': 'application/json' },
    JSON.stringify({ email: 'admin@cdp-tunnel.dev', password: 'admin123' })
  );
  const loginData = JSON.parse(loginRes);
  console.log('  Token:', loginData.token.substring(0, 30) + '...');
  
  const keysRes = await httpsRequest('GET', '/api/api-keys', 
    { 'Authorization': `Bearer ${loginData.token}` }
  );
  const keysData = JSON.parse(keysRes);
  
  const apiKey = keysData.apiKeys?.[0]?.key;
  if (!apiKey) {
    console.log('  ❌ 没有 API key，生成一个...');
    const newKeyRes = await httpsRequest('POST', '/api/api-keys',
      { 'Authorization': `Bearer ${loginData.token}`, 'Content-Type': 'application/json' },
      JSON.stringify({ name: 'demo-key' })
    );
    const newKeyData = JSON.parse(newKeyRes);
    return newKeyData.apiKey.key;
  }
  
  console.log('  API Key:', apiKey);
  return apiKey;
}

// Step 2: 获取浏览器列表
async function getBrowsers(apiKey) {
  console.log('\n=== Step 2: 获取浏览器列表 ===');
  const BASE = 'https://cdp.shanbox.19930810.xyz:8443';
  
  const browsersRes = await httpsRequest('GET', '/api/browsers',
    { 'Authorization': `Bearer ${apiKey}` }
  );
  const browsers = JSON.parse(browsersRes).browsers || [];
  
  console.log(`  在线浏览器: ${browsers.length}`);
  browsers.forEach((b, i) => {
    b.cdpHttpUrl = `https://cdp.shanbox.19930810.xyz:8443/json/version/${b.pluginId}`;
    console.log(`    [${i}] ${b.pluginName || 'Browser'} - pluginId=${b.pluginId} targets=${b.targets}`);
    console.log(`        CDP URL: ${b.cdpHttpUrl}`);
  });
  
  if (browsers.length === 0) {
    console.log('\n⚠ 没有在线浏览器！');
    console.log('  确保本地 Chromium 已启动且插件已连接');
    console.log('  插件连接地址应为: wss://cdp.shanbox.19930810.xyz:8443/plugin?key=' + apiKey);
    process.exit(1);
  }
  
  return browsers[0]; // 返回第一个浏览器
}

// Step 3: 连接浏览器
async function connectBrowser(browserInfo) {
  console.log(`\n=== Step 3: 连接浏览器 ===`);
  console.log('  Plugin ID:', browserInfo.pluginId);
  console.log('  CDP HTTP URL:', browserInfo.cdpHttpUrl);
  
  const browser = await chromium.connectOverCDP(browserInfo.cdpHttpUrl, { timeout: 20000 });
  console.log('  ✅ 已连接');
  
  return browser;
}

// Step 4: 百度搜索操作
async function baiduSearch(browser) {
  console.log('\n=== Step 4: 百度搜索 ===');
  
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  
  // 导航到百度
  console.log('  导航到百度...');
  await page.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded' });
  console.log('  ✅ 页面加载完成');
  
  // 等待一下让用户看到
  await page.waitForTimeout(2000);
  
  // 输入搜索内容
  console.log('  输入搜索内容...');
  await page.fill('#kw', 'cdp-tunnel 远程控制演示');
  console.log('  ✅ 搜索内容已填写');
  
  // 等待一下
  await page.waitForTimeout(1000);
  
  // 点击搜索按钮
  console.log('  点击搜索按钮...');
  await page.click('#su');
  console.log('  ✅ 搜索按钮已点击');
  
  // 等待搜索结果加载
  console.log('  等待搜索结果...');
  await page.waitForTimeout(3000);
  
  // 滚动查看结果
  console.log('  滚动查看搜索结果...');
  await page.evaluate(() => {
    window.scrollBy(0, 500);
  });
  console.log('  ✅ 已滚动');
  
  return page;
}

// Step 5: 新标签打开 example.com
async function openNewTab(browser) {
  console.log('\n=== Step 5: 新标签打开 example.com ===');
  
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  
  console.log('  导航到 example.com...');
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  console.log(`  ✅ 新标签已打开，标题: ${title}`);
  
  return page;
}

// Step 6: 在 example.com 上操作表单
async function operateOnExample(page) {
  console.log('\n=== Step 6: 在 example.com 上操作 ===');
  
  // 找到输入框（example.com 有多个 input）
  console.log('  查找输入框...');
  const inputs = await page.$$('input');
  console.log(`  找到 ${inputs.length} 个输入框`);
  
  if (inputs.length > 0) {
    // 填写输入框
    console.log('  填写输入框...');
    await inputs[0].fill('CDP Tunnel Remote Control Demo');
    console.log('  ✅ 输入内容已填写');
    
    await page.waitForTimeout(500);
    
    // 查找提交按钮
    console.log('  查找提交按钮...');
    const buttons = await page.$$('button, input[type="submit"]');
    console.log(`  找到 ${buttons.length} 个按钮`);
    
    if (buttons.length > 0) {
      await buttons[0].click();
      console.log('  ✅ 提交按钮已点击');
      await page.waitForTimeout(2000);
    }
  }
}

// HTTP 请求辅助函数
function httpsRequest(method, path, headers, body = null) {
  const BASE = 'https://cdp.shanbox.19930810.xyz:8443';
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'cdp.shanbox.19930810.xyz',
      port: 8443,
      path,
      method,
      headers: { ...headers, 'Host': 'cdp.shanbox.19930810.xyz' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 主函数
(async () => {
  console.log('========================================');
  console.log('  CDP Tunnel 远程控制完整演示');
  console.log('========================================\n');
  
  try {
    // Step 1: 登录
    const apiKey = await loginAndGetKey();
    
    // Step 2: 获取浏览器列表
    const browserInfo = await getBrowsers(apiKey);
    
    // Step 3: 连接
    const browser = await connectBrowser(browserInfo);
    
    // Step 4: 百度搜索
    const page1 = await baiduSearch(browser);
    
    // Step 5: 新标签打开 example.com
    const page2 = await openNewTab(browser);
    
    // Step 6: 在 example.com 上操作表单
    await operateOnExample(page2);
    
    // 等待一下让用户看清楚
    console.log('\n=== 完成！浏览器窗口将保持打开 30 秒 ===');
    await page1.waitForTimeout(30000);
    
    // 关闭浏览器
    await browser.close();
    console.log('\n✅ 浏览器已关闭');
    
    console.log('\n========================================');
    console.log('  你应该已经看到所有操作在你的本地 Chromium 上实时执行！');
    console.log('========================================');
    
  } catch (e) {
    console.error('\n❌ 执行失败:', e.message);
    process.exit(1);
  }
})();
