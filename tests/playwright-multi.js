const { chromium } = require('playwright');

const SERVER_URL = process.env.CDP_SERVER || 'http://localhost:8080';
const NUM_CLIENTS = parseInt(process.env.NUM_CLIENTS) || 2;

async function createClient(clientId) {
  console.log(`[${clientId}] Connecting to ${SERVER_URL}...`);
  
  const browser = await chromium.connectOverCDP(SERVER_URL);
  console.log(`[${clientId}] Connected!`);
  
  const context = browser.contexts()[0];
  const pages = context?.pages() || [];
  console.log(`[${clientId}] Found ${pages.length} page(s)`);
  
  return {
    id: clientId,
    browser,
    context,
    pages,
    async createPage(url) {
      console.log(`[${clientId}] Creating new page: ${url}`);
      const page = await this.context.newPage();
      await page.goto(url);
      this.pages.push(page);
      return page;
    },
    async scroll(pageIndex = 0, distance = 100) {
      const page = this.pages[pageIndex];
      if (page) {
        console.log(`[${clientId}] Scrolling page ${pageIndex}...`);
        await page.evaluate((d) => window.scrollBy(0, d), distance);
      }
    },
    async click(pageIndex = 0, selector) {
      const page = this.pages[pageIndex];
      if (page) {
        console.log(`[${clientId}] Clicking "${selector}" on page ${pageIndex}...`);
        await page.click(selector);
      }
    },
    async close() {
      console.log(`[${clientId}] Closing...`);
      await this.browser.close();
    }
  };
}

async function main() {
  console.log(`\n=== Starting ${NUM_CLIENTS} Playwright clients ===\n`);
  
  const clients = [];
  
  for (let i = 0; i < NUM_CLIENTS; i++) {
    const clientId = `client-${i + 1}`;
    const client = await createClient(clientId);
    clients.push(client);
  }
  
  console.log('\n=== All clients connected ===\n');
  
  await Promise.all(clients.map(async (client, idx) => {
    await client.createPage(`https://www.baidu.com`);
    await client.pages[client.pages.length - 1].waitForTimeout(1000 * (idx + 1));
  }));
  
  console.log('\n=== Testing concurrent scroll ===\n');
  
  await Promise.all(clients.map(async (client) => {
    for (let i = 0; i < 3; i++) {
      await client.scroll(0, 100);
      await new Promise(r => setTimeout(r, 500));
    }
  }));
  
  console.log('\n=== Test completed ===\n');
  
  for (const client of clients) {
    await client.close();
  }
  
  console.log('All clients closed.');
}

main().catch(console.error);
