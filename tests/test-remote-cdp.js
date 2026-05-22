const { chromium } = require('playwright');

(async () => {
  console.log('=== CDP Tunnel Playwright 自动化测试 ===\n');
  
  // 先尝试本地，再尝试远程
  const endpoints = [
    { name: '本地 CDP', url: 'http://localhost:9221' },
    { name: '远程 CDP', url: 'http://localhost:19221' }
  ];

  for (const ep of endpoints) {
    console.log(`--- 测试 ${ep.name}: ${ep.url} ---`);
    
    try {
      const resp = await fetch(ep.url + '/json/version');
      const ver = await resp.json();
      console.log('  Browser:', ver.Browser);
      console.log('  WS URL:', ver.webSocketDebuggerUrl);
      
      const targetsResp = await fetch(ep.url + '/json/list');
      const targets = await targetsResp.json();
      console.log('  Targets:', targets.length);
      
      if (targets.length === 0 && ep.name === '远程 CDP') {
        console.log('  ⚠️ 远程无 targets，plugin 可能离线，跳过\n');
        continue;
      }
    } catch (e) {
      console.log('  ❌ HTTP 检查失败:', e.message, '\n');
      continue;
    }

    let browser;
    try {
      console.log(`  连接 ${ep.name}...`);
      browser = await chromium.connectOverCDP(ep.url, { timeout: 30000 });
      console.log('  ✅ 连接成功！');
    } catch (e) {
      console.log('  ❌ 连接失败:', e.message.split('\n')[0], '\n');
      continue;
    }

    try {
      // 列出 contexts
      console.log('\n  Contexts:', browser.contexts().length);
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        const pages = contexts[0].pages();
        console.log('  已有页面:', pages.length);
        pages.slice(0, 3).forEach(p => console.log('    -', p.url().substring(0, 80)));
      }

      // 新建页面
      console.log('\n  新建页面 -> baidu.com...');
      const context = contexts[0] || await browser.newContext();
      const page = await context.newPage();
      await page.goto('https://www.baidu.com', { timeout: 15000 });
      const title = await page.title();
      console.log('  ✅ 页面标题:', title);

      // 搜索 - 点击搜索框后输入
      console.log('  搜索 "cdp-tunnel"...');
      try {
        await page.click('#kw', { force: true, timeout: 3000 }).catch(() => {});
        await page.fill('#kw', 'cdp-tunnel', { force: true }).catch(async () => {
          await page.evaluate(() => {
            const input = document.querySelector('#kw') || document.querySelector('input[name="wd"]');
            if (input) { input.value = 'cdp-tunnel'; input.dispatchEvent(new Event('input', { bubbles: true })); }
          });
        });
        await page.click('#su', { force: true, timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const resultTitle = await page.title();
        const resultUrl = page.url();
        console.log('  ✅ 搜索后标题:', resultTitle);
        console.log('  ✅ 搜索后 URL:', resultUrl.substring(0, 100));
      } catch (searchErr) {
        console.log('  ⚠️ 搜索操作异常:', searchErr.message.split('\n')[0]);
        // 改用简单页面验证
        console.log('  改用 example.com 验证...');
        await page.goto('https://example.com', { timeout: 10000 });
        const exTitle = await page.title();
        console.log('  ✅ Example.com 标题:', exTitle);
      }

      // 截图
      const screenshotPath = ep.name === '本地 CDP' 
        ? '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/local-cdp-screenshot.png'
        : '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/remote-cdp-screenshot.png';
      await page.screenshot({ path: screenshotPath });
      console.log('  ✅ 截图:', screenshotPath);

      // 关闭新建的页面
      await page.close().catch(() => {});
    } catch (e) {
      console.log('  ❌ 操作失败:', e.message);
    }

    await browser.close().catch(() => {});
    console.log('\n  连接已关闭\n');
  }

  console.log('=== 测试结束 ===');
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
