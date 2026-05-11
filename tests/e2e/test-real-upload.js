#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');

const PROXY_PORT = 19239;
const EXTENSION_PATH = path.resolve(__dirname, '../../extension-new');
const PROXY_PATH = path.resolve(__dirname, '../../server/proxy-server.js');
const CONFIG_PATH = path.resolve(__dirname, '../../extension-new/utils/config.js');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

let proxyProcess = null;
let chromeProcess = null;
let configOriginal = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function patchConfig(port) {
  configOriginal = fs.readFileSync(CONFIG_PATH, 'utf8');
  fs.writeFileSync(
    CONFIG_PATH,
    configOriginal.replace(
      /WS_URL:\s*'ws:\/\/localhost:9221\/plugin'/,
      `WS_URL: 'ws://localhost:${port}/plugin'`
    )
  );
}

function restoreConfig() {
  if (configOriginal) {
    fs.writeFileSync(CONFIG_PATH, configOriginal);
    configOriginal = null;
  }
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForProxy(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await httpGet(port, '/json/version');
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function waitForExtension(port, maxWait = 45000) {
  await sleep(5000);
  let reqId = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const ws = new WebSocket(`ws://localhost:${port}/client`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const id = ++reqId;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off('message', handler);
          reject(new Error('timeout'));
        }, 5000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      });
      ws.close();
      if (result && result.targetInfos && result.targetInfos.length > 0) return true;
    } catch (e) {
      log('SETUP', `  Waiting for extension... (${e.message})`);
    }
    await sleep(3000);
  }
  return false;
}

function cleanup() {
  if (chromeProcess) {
    try { process.kill(-chromeProcess.pid, 'SIGKILL'); } catch {}
    if (chromeProcess._profile) {
      try { fs.rmSync(chromeProcess._profile, { recursive: true, force: true }); } catch {}
    }
    chromeProcess = null;
  }
  if (proxyProcess) {
    try { proxyProcess.kill('SIGINT'); } catch {}
    proxyProcess = null;
  }
  restoreConfig();
}

const FORM_HTML = `<!DOCTYPE html>
<html><body>
<form id="form">
  <input type="file" id="upload" />
  <input type="text" id="name" placeholder="Name" />
  <input type="email" id="email" placeholder="Email" />
  <select id="country">
    <option value="cn">China</option>
    <option value="us">USA</option>
    <option value="jp">Japan</option>
  </select>
  <textarea id="message" placeholder="Message"></textarea>
  <button type="submit">Submit</button>
</form>
<div id="result"></div>
<script>
document.getElementById('form').addEventListener('submit', function(e) {
  e.preventDefault();
  var file = document.getElementById('upload').files[0];
  var name = document.getElementById('name').value;
  var email = document.getElementById('email').value;
  var country = document.getElementById('country').value;
  var message = document.getElementById('message').value;
  document.getElementById('result').textContent = JSON.stringify({
    fileName: file ? file.name : null,
    fileSize: file ? file.size : null,
    name: name, email: email, country: country, message: message
  });
});
</script>
</body></html>`;

async function runTest() {
  console.log('========================================');
  console.log('  File Upload & Form Interaction Test');
  console.log('  CDP Tunnel: http://localhost:' + PROXY_PORT);
  console.log('========================================\n');

  try {
    log('SETUP', 'Patching extension config...');
    patchConfig(PROXY_PORT);

    log('SETUP', 'Starting proxy server...');
    proxyProcess = spawn('node', [PROXY_PATH], {
      env: { ...process.env, PORT: String(PROXY_PORT), LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proxyProcess.stderr?.on('data', d => {
      d.toString().trim().split('\n').forEach(l => {
        if (l.includes('ERROR')) log('PROXY-ERR', l);
      });
    });

    if (!await waitForProxy(PROXY_PORT)) {
      throw new Error('Proxy did not become ready');
    }
    log('SETUP', 'Proxy is ready');

    log('SETUP', 'Starting Chrome with extension...');
    const userDataDir = `/tmp/pw-upload-test-${Date.now()}`;
    chromeProcess = spawn(CHROME_PATH, [
      `--load-extension=${EXTENSION_PATH}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-sandbox',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    chromeProcess._profile = userDataDir;

    log('SETUP', 'Waiting for extension to connect...');
    if (!await waitForExtension(PROXY_PORT)) {
      throw new Error('Extension did not connect');
    }
    log('SETUP', 'Extension connected!');

    await sleep(2000);

    const CDP_URL = `http://localhost:${PROXY_PORT}`;

    // === Test 1: Connect and create page ===
    console.log('\n--- Test 1: Connect via CDP ---');

    const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    console.log('✅ Connected to CDP tunnel');

    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    console.log('✅ Created new page');

    // === Test 2: Set content with form ===
    console.log('\n--- Test 2: Set page content ---');

    await page.setContent(FORM_HTML);
    console.log('✅ Page content set');

    const title = await page.title();
    console.log(`  Page title: "${title}"`);

    // === Test 3: File upload ===
    console.log('\n--- Test 3: File upload ---');

    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `test-upload-${Date.now()}.txt`);
    const fileContent = 'Hello from CDP Tunnel upload test!';
    fs.writeFileSync(tmpFile, fileContent);
    console.log(`  Created temp file: ${tmpFile} (${fileContent.length} bytes)`);

    const fileInput = page.locator('#upload');
    await fileInput.setInputFiles(tmpFile);
    console.log('✅ File uploaded via setInputFiles');

    const uploadedFileName = await page.evaluate(() => {
      return document.getElementById('upload').files[0].name;
    });
    console.log(`  Uploaded file name: "${uploadedFileName}"`);

    const uploadedFileSize = await page.evaluate(() => {
      return document.getElementById('upload').files[0].size;
    });
    console.log(`  Uploaded file size: ${uploadedFileSize} bytes`);

    if (!uploadedFileName.endsWith('.txt')) {
      throw new Error(`File name mismatch: ${uploadedFileName}`);
    }
    if (uploadedFileSize !== fileContent.length) {
      throw new Error(`File size mismatch: expected ${fileContent.length}, got ${uploadedFileSize}`);
    }
    console.log('✅ File upload verified');

    // === Test 4: Text input ===
    console.log('\n--- Test 4: Text input ---');

    await page.fill('#name', 'Test User');
    console.log('✅ Filled name field');

    await page.fill('#email', 'test@example.com');
    console.log('✅ Filled email field');

    const nameValue = await page.inputValue('#name');
    const emailValue = await page.inputValue('#email');
    console.log(`  Name: "${nameValue}", Email: "${emailValue}"`);

    if (nameValue !== 'Test User') throw new Error('Name mismatch');
    if (emailValue !== 'test@example.com') throw new Error('Email mismatch');

    // === Test 5: Select dropdown ===
    console.log('\n--- Test 5: Select dropdown ---');

    await page.selectOption('#country', 'us');
    const countryValue = await page.inputValue('#country');
    console.log(`  Country selected: "${countryValue}"`);

    if (countryValue !== 'us') throw new Error('Country mismatch');

    // === Test 6: Textarea ===
    console.log('\n--- Test 6: Textarea ---');

    await page.fill('#message', 'This is a test message from Playwright via CDP Tunnel.');
    console.log('✅ Filled textarea');

    const msgValue = await page.inputValue('#message');
    console.log(`  Message: "${msgValue.substring(0, 40)}..."`);

    if (!msgValue.includes('Playwright via CDP Tunnel')) throw new Error('Message mismatch');

    // === Test 7: Form submission ===
    console.log('\n--- Test 7: Form submission ---');

    await page.click('button[type="submit"]');
    await sleep(500);

    const resultText = await page.textContent('#result');
    console.log(`  Result: ${resultText}`);

    const result = JSON.parse(resultText);
    if (result.fileName !== path.basename(tmpFile)) {
      throw new Error(`File name in result mismatch: ${result.fileName}`);
    }
    if (result.name !== 'Test User') throw new Error('Name in result mismatch');
    if (result.email !== 'test@example.com') throw new Error('Email in result mismatch');
    if (result.country !== 'us') throw new Error('Country in result mismatch');
    if (result.message !== msgValue) throw new Error('Message in result mismatch');

    console.log('✅ Form submission verified all fields');

    // === Test 8: Multiple file upload ===
    console.log('\n--- Test 8: Multiple file upload ---');

    const tmpFile2 = path.join(tmpDir, `test-upload-2-${Date.now()}.json`);
    fs.writeFileSync(tmpFile2, JSON.stringify({ test: true }));
    const tmpFile3 = path.join(tmpDir, `test-upload-3-${Date.now()}.csv`);
    fs.writeFileSync(tmpFile3, 'a,b,c\n1,2,3');

    await fileInput.setInputFiles([tmpFile2, tmpFile3]);
    console.log('✅ Uploaded multiple files');

    const fileCount = await page.evaluate(() => {
      return document.getElementById('upload').files.length;
    });
    console.log(`  File count: ${fileCount}`);

    if (fileCount !== 2) throw new Error(`Expected 2 files, got ${fileCount}`);

    const fileNames = await page.evaluate(() => {
      return Array.from(document.getElementById('upload').files).map(f => f.name);
    });
    console.log(`  File names: ${fileNames.join(', ')}`);
    console.log('✅ Multiple file upload verified');

    // === Cleanup ===
    console.log('\n--- Cleanup ---');

    fs.unlinkSync(tmpFile);
    fs.unlinkSync(tmpFile2);
    fs.unlinkSync(tmpFile3);
    console.log('✅ Temp files removed');

    await page.close();
    await browser.close();
    console.log('✅ Browser closed');

    cleanup();

    console.log('\n========================================');
    console.log('  ALL TESTS PASSED ✅');
    console.log('========================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    cleanup();
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

runTest();
