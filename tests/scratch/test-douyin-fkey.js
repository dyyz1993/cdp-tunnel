const { chromium } = require('playwright');

async function testDouyinScenario() {
  console.log('[Douyin Test] 启动测试...');
  console.log('[Douyin Test] 连接到 CDP proxy: ws://localhost:9221');

  const DOUYIN_URL = 'https://www.douyin.com/user/MS4wLjABAAAAnKeRN8QUgooS1pPRqOf_N_jnuztzUyocl0_vUndQFJs?modal_id=7635666432337351530';

  let browser;
  let disconnected = false;

  try {
    browser = await chromium.connectOverCDP('http://localhost:9221');
    console.log('[Douyin Test] CDP 连接成功!');

    browser.on('disconnected', () => {
      disconnected = true;
      console.log('[Douyin Test] >>>>> CDP 连接断开了! <<<<<');
    });

    const context = browser.contexts()[0];
    const pages = context.pages();
    console.log(`[Douyin Test] 当前有 ${pages.length} 个页面`);

    console.log('\n--- 步骤1: 打开抖音视频页面 ---');
    const page = await context.newPage();
    await page.goto(DOUYIN_URL);
    console.log('[Douyin Test] 抖音页面已打开:', page.url());

    console.log('\n--- 等待页面加载 ---');
    await page.waitForTimeout(8000);

    console.log('\n--- 步骤2: 查找入口图标并点击 (打开弹窗) ---');
    try {
      const entryIconSelector = '.r68hW_1W, [class*="entryIcon"], svg[class*="wNbQukcA"]';
      const icons = await page.locator(entryIconSelector).all();

      if (icons.length === 0) {
        console.log('[Douyin Test] 未找到特定图标，尝试查找所有SVG...');
        const svgIcons = await page.locator('svg').all();
        console.log(`[Douyin Test] 找到 ${svgIcons.length} 个SVG元素`);
      } else {
        console.log(`[Douyin Test] 找到 ${icons.length} 个可能的入口图标`);
      }

      const possibleSelectors = [
        '.r68hW_1W',
        '[class*="entryIcon"]',
        'svg[class*="wNbQukcA"]',
        '[class*="O3Mbz6KI"]',
        '[aria-describedby="blet6is"]'
      ];

      for (const selector of possibleSelectors) {
        try {
          const element = page.locator(selector).first();
          const isVisible = await element.isVisible({ timeout: 2000 }).catch(() => false);
          if (isVisible) {
            console.log(`[Douyin Test] 点击元素: ${selector}`);
            await element.click({ timeout: 3000 });
            console.log('[Douyin Test] 点击成功!');
            await page.waitForTimeout(3000);
            break;
          }
        } catch (e) {
          console.log(`[Douyin Test] 选择器 ${selector} 失败:`, e.message);
        }
      }
    } catch (e) {
      console.log('[Douyin Test] 查找入口图标失败:', e.message);
    }

    console.log('\n--- 步骤3: 在弹窗中查找并点击 input ---');
    try {
      const inputSelectors = [
        'input[type="text"]',
        'input[type="search"]',
        'input[placeholder*="评论"]',
        'input[placeholder*="说"]',
        'textarea',
        '[contenteditable="true"]'
      ];

      for (const selector of inputSelectors) {
        try {
          const inputs = await page.locator(selector).all();
          console.log(`[Douyin Test] 选择器 ${selector} 找到 ${inputs.length} 个元素`);

          for (const input of inputs) {
            try {
              const isVisible = await input.isVisible({ timeout: 1000 }).catch(() => false);
              if (isVisible) {
                console.log(`[Douyin Test] 点击可见的 ${selector}...`);
                await input.click({ timeout: 2000 });
                console.log('[Douyin Test] 点击 input 成功!');
                await page.waitForTimeout(1000);

                await input.fill('test comment');
                console.log('[Douyin Test] 输入文本成功!');
                await page.waitForTimeout(2000);
                break;
              }
            } catch (e) {
              console.log(`[Douyin Test] 处理 input 失败:`, e.message);
            }
          }
        } catch (e) {
          console.log(`[Douyin Test] 选择器 ${selector} 失败:`, e.message);
        }
      }
    } catch (e) {
      console.log('[Douyin Test] 查找input失败:', e.message);
    }

    console.log('\n--- 步骤4: 查找弹窗中的 iframe 并操作 iframe 内的 input ---');
    try {
      const iframeSelectors = [
        'iframe',
        '[class*="iframe"]',
        '[class*="comment"] iframe',
        '[class*="modal"] iframe',
        '[class*="popup"] iframe'
      ];

      for (const selector of iframeSelectors) {
        try {
          const iframes = await page.locator(selector).all();
          console.log(`[Douyin Test] 选择器 ${selector} 找到 ${iframes.length} 个iframe`);

          for (let i = 0; i < Math.min(iframes.length, 5); i++) {
            try {
              const iframe = iframes[i];
              const isVisible = await iframe.isVisible({ timeout: 1000 }).catch(() => false);
              if (isVisible) {
                const iframeSrc = await iframe.getAttribute('src').catch(() => null);
                console.log(`[Douyin Test] iframe ${i}: visible=${isVisible}, src=${iframeSrc ? iframeSrc.substring(0, 80) : 'null'}`);

                try {
                  const frame = page.frame({ url: iframeSrc });
                  if (frame) {
                    console.log(`[Douyin Test] 尝试在 iframe ${i} 中查找 input...`);
                    const iframeInputs = await frame.locator('input[type="text"], textarea, [contenteditable="true"]').all();
                    console.log(`[Douyin Test] iframe ${i} 内找到 ${iframeInputs.length} 个输入元素`);

                    for (const input of iframeInputs) {
                      try {
                        const inputVisible = await input.isVisible({ timeout: 1000 }).catch(() => false);
                        if (inputVisible) {
                          console.log(`[Douyin Test] 在 iframe 中点击 input...`);
                          await input.click({ timeout: 2000 });
                          console.log('[Douyin Test] iframe 内点击 input 成功!');
                          await page.waitForTimeout(500);
                          await input.fill('test from iframe');
                          console.log('[Douyin Test] iframe 内输入成功!');
                          await page.waitForTimeout(2000);
                          break;
                        }
                      } catch (e) {
                        console.log(`[Douyin Test] iframe input 处理失败:`, e.message);
                      }
                    }
                  }
                } catch (e) {
                  console.log(`[Douyin Test] 访问 iframe ${i} 失败:`, e.message);
                }
              }
            } catch (e) {
              console.log(`[Douyin Test] iframe ${i} 处理失败:`, e.message);
            }
          }
        } catch (e) {
          console.log(`[Douyin Test] 选择器 ${selector} 失败:`, e.message);
        }
      }
    } catch (e) {
      console.log('[Douyin Test] 查找iframe失败:', e.message);
    }

    console.log('\n--- 步骤5: 执行更多交互 ---');
    try {
      await page.mouse.click(100, 100);
      console.log('[Douyin Test] 点击页面 (100, 100)');
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log('[Douyin Test] 点击失败:', e.message);
    }

    console.log('\n--- 等待观察是否断开 ---');
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      if (disconnected) {
        console.log(`[Douyin Test] 在第 ${i+1} 秒时检测到断开!`);
        break;
      }
      console.log(`[Douyin Test] 连接仍然活跃... ${i+1}s`);
    }

    if (!disconnected) {
      console.log('\n[Douyin Test] 测试完成，连接未断开');
    }

  } catch (error) {
    console.error('[Douyin Test] 错误:', error.message);
    console.error('[Douyin Test] Stack:', error.stack);
  } finally {
    if (browser && !disconnected) {
      console.log('\n[Douyin Test] 关闭浏览器...');
      await browser.close().catch(() => {});
    }
  }

  return disconnected;
}

testDouyinScenario()
  .then(disconnected => {
    console.log('\n========== 测试结果 ==========');
    console.log('连接断开:', disconnected ? '是' : '否');
    console.log('==============================');
    process.exit(disconnected ? 1 : 0);
  })
  .catch(console.error);
