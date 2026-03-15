const { chromium } = require('playwright');
const readline = require('readline');

const SERVER_URL = process.env.CDP_SERVER || 'http://localhost:8080';

const clients = [];
let currentClient = 0;

async function createClient(name) {
  console.log(`[${name}] Connecting to ${SERVER_URL}...`);
  
  const browser = await chromium.connectOverCDP(SERVER_URL);
  const context = browser.contexts()[0];
  
  console.log(`[${name}] Connected!`);
  
  return {
    name,
    browser,
    context,
    pages: context?.pages() || [],
    commandId: 1
  };
}

async function main() {
  console.log('\n=== Playwright Multi-Client Interactive Test ===\n');
  console.log(`Server: ${SERVER_URL}\n`);
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const commands = {
    help: () => {
      console.log(`
Commands:
  c <name>              - Create new client with name
  l                     - List all clients
  s <client> <page>     - Switch to client/page
  n <url>               - Create new page with URL
  g <url>               - Navigate current page to URL
  scroll <distance>     - Scroll current page
  click <selector>      - Click element on current page
  type <selector> <text> - Type text into element
  eval <code>           - Evaluate JavaScript
  screenshot <file>     - Take screenshot
  info                  - Show current page info
  close <client>        - Close specific client
  q                     - Quit
`);
    },
    
    list: () => {
      console.log(`\nClients (${clients.length}):`);
      clients.forEach((c, i) => {
        console.log(`  [${i}] ${c.name} - ${c.pages.length} page(s)`);
        c.pages.forEach((p, j) => {
          console.log(`      Page ${j}: ${p.url()?.substring(0, 50)}`);
        });
      });
      console.log('');
    },
    
    create: async (name) => {
      if (!name) {
        console.log('Usage: c <name>');
        return;
      }
      const client = await createClient(name);
      clients.push(client);
      currentClient = clients.length - 1;
      console.log(`Created client "${name}", switched to it.\n`);
    },
    
    switch: (clientIdx, pageIdx) => {
      const ci = parseInt(clientIdx);
      const pi = parseInt(pageIdx) || 0;
      if (ci >= 0 && ci < clients.length) {
        currentClient = ci;
        console.log(`Switched to client ${ci}, page ${pi}\n`);
      } else {
        console.log('Invalid client index\n');
      }
    },
    
    newPage: async (url) => {
      const client = clients[currentClient];
      if (!client) {
        console.log('No client selected. Use "c <name>" to create one.\n');
        return;
      }
      const page = await client.context.newPage();
      client.pages.push(page);
      if (url) {
        await page.goto(url);
      }
      console.log(`Created page ${client.pages.length - 1}: ${page.url()}\n`);
    },
    
    goto: async (url) => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) {
        console.log('No page available.\n');
        return;
      }
      await page.goto(url);
      console.log(`Navigated to: ${page.url()}\n`);
    },
    
    scroll: async (distance = 100) => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) return;
      await page.evaluate((d) => window.scrollBy(0, d), parseInt(distance));
      console.log(`Scrolled ${distance}px\n`);
    },
    
    click: async (selector) => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) return;
      await page.click(selector);
      console.log(`Clicked: ${selector}\n`);
    },
    
    type: async (selector, text) => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) return;
      await page.fill(selector, text);
      console.log(`Typed into: ${selector}\n`);
    },
    
    eval: async (code) => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) return;
      const result = await page.evaluate(code);
      console.log(`Result:`, result, '\n');
    },
    
    screenshot: async (filename = 'screenshot.png') => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) return;
      await page.screenshot({ path: `tests/${filename}` });
      console.log(`Saved: tests/${filename}\n`);
    },
    
    info: async () => {
      const client = clients[currentClient];
      const page = client?.pages[0];
      if (!page) {
        console.log('No page available.\n');
        return;
      }
      console.log(`
Client: ${client.name}
Page URL: ${page.url()}
Page Title: ${await page.title()}
`);
    },
    
    closeClient: async (idx) => {
      const i = parseInt(idx);
      if (i >= 0 && i < clients.length) {
        await clients[i].browser.close();
        console.log(`Closed client ${i}: ${clients[i].name}\n`);
        clients.splice(i, 1);
        if (currentClient >= clients.length) {
          currentClient = Math.max(0, clients.length - 1);
        }
      }
    },
    
    quit: async () => {
      console.log('\nClosing all clients...');
      for (const c of clients) {
        await c.browser.close();
      }
      rl.close();
      process.exit(0);
    }
  };
  
  console.log('Type "help" for commands.\n');
  
  rl.on('line', async (input) => {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    
    try {
      switch (cmd) {
        case 'help':
        case 'h':
        case '?':
          commands.help();
          break;
        case 'l':
        case 'list':
          commands.list();
          break;
        case 'c':
          await commands.create(args[0]);
          break;
        case 's':
          commands.switch(args[0], args[1]);
          break;
        case 'n':
          await commands.newPage(args[0]);
          break;
        case 'g':
          await commands.goto(args[0]);
          break;
        case 'scroll':
          await commands.scroll(args[0]);
          break;
        case 'click':
          await commands.click(args[0]);
          break;
        case 'type':
          await commands.type(args[0], args[1]);
          break;
        case 'eval':
          await commands.eval(args.join(' '));
          break;
        case 'screenshot':
          await commands.screenshot(args[0]);
          break;
        case 'info':
        case 'i':
          await commands.info();
          break;
        case 'close':
          await commands.closeClient(args[0]);
          break;
        case 'q':
        case 'quit':
        case 'exit':
          await commands.quit();
          break;
        default:
          console.log('Unknown command. Type "help" for commands.\n');
      }
    } catch (err) {
      console.error('Error:', err.message, '\n');
    }
    
    rl.prompt();
  }).on('close', async () => {
    await commands.quit();
  });
  
  rl.prompt();
}

main().catch(console.error);
