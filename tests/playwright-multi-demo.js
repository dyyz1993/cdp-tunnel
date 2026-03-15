const { chromium } = require('playwright');

const SERVER_URL = process.env.CDP_SERVER || 'http://localhost:9221';

async function main() {
  console.log('\n=== 多客户端测试 ===\n');
  console.log('服务器地址:', SERVER_URL);
  console.log('\n提示: 所有客户端连接同一个端点，服务器自动分配不同的 clientId\n');
  
  const clients = [];
  
  // 创建 3 个客户端
  for (let i = 1; i <= 3; i++) {
    console.log(`[Client ${i}] 连接中...`);
    const browser = await chromium.connectOverCDP(SERVER_URL);
    const context = browser.contexts()[0];
    clients.push({ id: i, browser, context, pages: [] });
    console.log(`[Client ${i}] 已连接!`);
  }
  
  console.log('\n>>> 请打开配置页面查看 3 个 CDP 客户端:');
  console.log('>>> chrome-extension://bchclccgjmihieacfmaelkpfjlghhoph/config-page-preview.html');
  console.log('>>> 等待 15 秒...\n');
  
  await new Promise(r => setTimeout(r, 15000));
  
  // 每个客户端创建一个页面
  for (const client of clients) {
    console.log(`[Client ${client.id}] 创建页面...`);
    const page = await client.context.newPage();
    await page.goto('https://www.baidu.com');
    client.pages.push(page);
  }
  
  console.log('\n>>> 3 个页面已创建，等待 10 秒...\n');
  await new Promise(r => setTimeout(r, 10000));
  
  // 并发操作
  console.log('>>> 并发滚动测试...\n');
  await Promise.all(clients.map(async (client) => {
    for (let i = 0; i < 3; i++) {
      await client.pages[0].evaluate(() => window.scrollBy(0, 100));
      console.log(`[Client ${client.id}] 滚动 ${i + 1}`);
      await new Promise(r => setTimeout(r, 300));
    }
  }));
  
  console.log('\n>>> 测试完成，等待 5 秒后关闭...\n');
  await new Promise(r => setTimeout(r, 5000));
  
  // 关闭所有客户端
  for (const client of clients) {
    console.log(`[Client ${client.id}] 关闭...`);
    await client.browser.close();
  }
  
  console.log('\n所有客户端已关闭。');
}

main().catch(console.error);
