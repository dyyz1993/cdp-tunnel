const { chromium } = require('playwright');

async function main() {
  console.log('启动浏览器...');
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  
  // 打开配置页面
  const configUrl = 'chrome-extension://bchclccgjmihieacfmaelkpfjlghhoph/config-page-preview.html';
  console.log('打开配置页面:', configUrl);
  
  await page.goto(configUrl);
  await page.waitForTimeout(2000);
  
  // 截图
  const screenshotPath = 'docs/config-page-screenshot.png';
  await page.screenshot({ 
    path: screenshotPath, 
    fullPage: true 
  });
  console.log('截图已保存:', screenshotPath);
  
  console.log('\n请在浏览器中查看配置页面，然后手动截图');
  console.log('等待 30 秒...');
  
  await page.waitForTimeout(30000);
  
  await browser.close();
}

main().catch(console.error);
