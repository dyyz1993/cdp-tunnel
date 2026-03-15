const WebSocket = require('ws');

const SERVER_URL = process.argv[2] || 'ws://localhost:8080';
const CLIENT_ID = process.argv[3] || 'test-client-1';

console.log(`[Test Client ${CLIENT_ID}] Connecting to ${SERVER_URL}...`);

const ws = new WebSocket(SERVER_URL);

ws.on('open', () => {
  console.log(`[Test Client ${CLIENT_ID}] Connected!`);
  
  ws.send(JSON.stringify({
    type: 'identify',
    clientId: CLIENT_ID
  }));
  
  console.log(`[Test Client ${CLIENT_ID}] Sent identify message`);
  
  console.log(`[Test Client ${CLIENT_ID}] Enabling Target domain...`);
  ws.send(JSON.stringify({
    id: 1,
    method: 'Target.setDiscoverTargets',
    params: { discover: true }
  }));
  
  setTimeout(() => {
    console.log(`[Test Client ${CLIENT_ID}] Getting targets...`);
    ws.send(JSON.stringify({
      id: 2,
      method: 'Target.getTargets',
      params: {}
    }));
  }, 1000);
  
  setTimeout(() => {
    console.log(`[Test Client ${CLIENT_ID}] Creating new page...`);
    ws.send(JSON.stringify({
      id: 3,
      method: 'Target.createTarget',
      params: { url: 'https://www.baidu.com' }
    }));
  }, 2000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    
    if (msg.method && msg.method.startsWith('Target.')) {
      console.log(`[Test Client ${CLIENT_ID}] Event: ${msg.method}`, 
        msg.params?.targetInfo?.url || msg.params?.targetId || '');
    } else if (msg.id) {
      console.log(`[Test Client ${CLIENT_ID}] Response to #${msg.id}:`, 
        msg.result ? 'success' : msg.error);
      if (msg.result && msg.result.targetInfos) {
        console.log(`  Targets: ${msg.result.targetInfos.length}`);
        msg.result.targetInfos.forEach(t => {
          console.log(`    - ${t.type}: ${t.url || t.title}`);
        });
      }
      if (msg.result && msg.result.targetId) {
        console.log(`  Created target: ${msg.result.targetId}`);
      }
    } else {
      console.log(`[Test Client ${CLIENT_ID}] Message:`, msg.type || msg.method);
    }
  } catch (e) {
    console.log(`[Test Client ${CLIENT_ID}] Raw message:`, data.toString().substring(0, 100));
  }
});

ws.on('close', () => {
  console.log(`[Test Client ${CLIENT_ID}] Disconnected`);
});

ws.on('error', (err) => {
  console.error(`[Test Client ${CLIENT_ID}] Error:`, err.message);
});

process.on('SIGINT', () => {
  console.log(`\n[Test Client ${CLIENT_ID}] Closing...`);
  ws.close();
  process.exit(0);
});

console.log('\nUsage: node test-client.js [server_url] [client_id]');
console.log('Example: node test-client.js ws://localhost:8080 client-1');
console.log('\nPress Ctrl+C to exit\n');
