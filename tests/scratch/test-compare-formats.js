const WebSocket = require('ws');

async function testCDPTunnel() {
  console.log('\n=== Testing CDP Tunnel ===\n');
  
  const ws = new WebSocket('ws://localhost:9221/client');
  
  ws.on('open', () => {
    console.log('[CDP Tunnel] Connected');
    
    // 启用 Target 域
    ws.send(JSON.stringify({
      id: 1,
      method: 'Target.setDiscoverTargets',
      params: { discover: true }
    }));
    console.log('[CDP Tunnel] Sent Target.setDiscoverTargets');
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Target.targetCreated') {
        console.log('[CDP Tunnel] Received Target.targetCreated:');
        console.log('  Raw:', JSON.stringify(msg).substring(0, 200));
        console.log('  Has method:', !!msg.method);
        console.log('  Has params:', !!msg.params);
        console.log('  Has targetInfo:', !!msg.params?.targetInfo);
      }
    } catch (e) {}
  });
  
  await new Promise(r => setTimeout(r, 15000));
  ws.close();
}

async function testNativeCDP() {
  console.log('\n=== Testing Native CDP (port 9222) ===\n');
  
  // 先启动 Chromium
  const { spawn } = require('child_process');
  const chrome = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', [
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/chrome-test-format',
    '--no-first-run'
  ], { detached: true, stdio: 'ignore' });
  
  await new Promise(r => setTimeout(r, 3000));
  
  const ws = new WebSocket('ws://localhost:9222/devtools/browser');
  
  ws.on('open', () => {
    console.log('[Native CDP] Connected');
    
    ws.send(JSON.stringify({
      id: 1,
      method: 'Target.setDiscoverTargets',
      params: { discover: true }
    }));
    console.log('[Native CDP] Sent Target.setDiscoverTargets');
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Target.targetCreated') {
        console.log('[Native CDP] Received Target.targetCreated:');
        console.log('  Raw:', JSON.stringify(msg).substring(0, 200));
        console.log('  Has method:', !!msg.method);
        console.log('  Has params:', !!msg.params);
        console.log('  Has targetInfo:', !!msg.params?.targetInfo);
      }
    } catch (e) {}
  });
  
  await new Promise(r => setTimeout(r, 15000));
  ws.close();
  
  try { process.kill(-chrome.pid); } catch(e) {}
}

async function main() {
  await testCDPTunnel();
  await testNativeCDP();
  process.exit(0);
}

main();
