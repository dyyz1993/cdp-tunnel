const { chromium } = require('playwright');
const https = require('https');

const BASE = 'https://cdp.shanbox.19930810.xyz:8443';

function httpRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { ...headers }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== SaaS 全链路验证 ===\n');
  const errors = [];

  // Step 1: Login
  console.log('Step 1: Login');
  let token, apiKey;
  try {
    const result = await httpRequest('POST', '/api/auth/login', 
      { 'Content-Type': 'application/json' },
      JSON.stringify({ email: 'admin@cdp-tunnel.dev', password: 'admin123' })
    );
    token = result.token;
    apiKey = result.apiKeys?.[0]?.key;
    console.log('  Token:', token?.substring(0, 20) + '...');
    console.log('  API Key:', apiKey);
  } catch (e) {
    console.log('  Error:', e.message);
    errors.push('login');
  }

  if (!token) {
    console.log('Cannot continue without login');
    process.exit(1);
  }

  // Step 2: List browsers
  console.log('\nStep 2: List browsers');
  let browsers;
  try {
    const result = await httpRequest('GET', '/api/browsers',
      { 'Authorization': `Bearer ${token}` }
    );
    browsers = result.browsers || [];
    console.log('  Browsers:', browsers.length);
    browsers.forEach((b, i) => {
      console.log(`    [${i}] ${b.pluginName || 'Browser'} - pluginId=${b.pluginId} targets=${b.targets} connected=${b.connected}`);
    });
  } catch (e) {
    console.log('  Error:', e.message);
    errors.push('list-browsers');
  }

  if (!browsers || browsers.length === 0) {
    console.log('\nNo browsers connected.');
    console.log('Make sure Chromium plugin is running and connected.');
  } else {
    // Step 3: Connect to browser via Playwright
    const browserInfo = browsers[0];
    console.log('\nStep 3: Connect to browser via Playwright');

    // Use the CDP endpoint directly through the SaaS proxy
    const cdpUrl = `wss://cdp.shanbox.19930810.xyz:8443/devtools/browser/${browserInfo.pluginId}`;
    console.log('  CDP Endpoint via SaaS:', cdpUrl);

    let browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
      console.log('  Browser connected');

      const ctx = browser.contexts()[0] || await browser.newContext();
      const page = await ctx.newPage();
      await page.goto('https://example.com', { timeout: 10000 });
      const title = await page.title();
      console.log('  Page title:', title);

      await page.screenshot({ path: '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/tests/saas-test.png' });
      console.log('  Screenshot saved');

      await browser.close();
      console.log('\nAll CDP operations successful!');
    } catch (e) {
      console.log('  Error:', e.message);
      errors.push('cdp-operations');
    }
  }

  console.log('\n=== Results ===');
  if (errors.length === 0) {
    console.log('SaaS 全链路验证通过!');
  } else {
    console.log('Failed:', errors.length);
    errors.forEach(e => console.log('  -', e));
  }
})().catch(e => {
  console.error('Fatal:', e.message);
});
