const WebSocket = require('ws');

const SERVER_URL = process.argv[2] || 'ws://localhost:9222';
const NUM_CLIENTS = parseInt(process.argv[3]) || 2;

console.log(`Starting ${NUM_CLIENTS} test clients connecting to ${SERVER_URL}...\n`);

const clients = [];

for (let i = 0; i < NUM_CLIENTS; i++) {
  const clientId = `test-client-${i + 1}`;
  const client = createClient(clientId);
  clients.push(client);
}

function createClient(clientId) {
  console.log(`[${clientId}] Connecting...`);
  
  const ws = new WebSocket(SERVER_URL);
  let commandId = 1;
  
  ws.on('open', () => {
    console.log(`[${clientId}] Connected!`);
    
    ws.send(JSON.stringify({
      type: 'identify',
      clientId: clientId
    }));
    
    ws.send(JSON.stringify({
      id: commandId++,
      method: 'Target.setDiscoverTargets',
      params: { discover: true }
    }));
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.method === 'Target.targetCreated') {
        console.log(`[${clientId}] Target created: ${msg.params.targetInfo?.url || msg.params.targetInfo?.type}`);
      } else if (msg.method === 'Target.attachedToTarget') {
        console.log(`[${clientId}] Attached to target: sessionId=${msg.params.sessionId?.substring(0, 8)}...`);
      } else if (msg.method === 'Target.targetDestroyed') {
        console.log(`[${clientId}] Target destroyed`);
      } else if (msg.id) {
        if (msg.result?.targetInfos) {
          console.log(`[${clientId}] Got ${msg.result.targetInfos.length} targets`);
        }
      }
    } catch (e) {}
  });
  
  ws.on('close', () => {
    console.log(`[${clientId}] Disconnected`);
  });
  
  ws.on('error', (err) => {
    console.error(`[${clientId}] Error:`, err.message);
  });
  
  return {
    ws,
    clientId,
    send: (method, params) => {
      ws.send(JSON.stringify({ id: commandId++, method, params }));
    },
    close: () => ws.close()
  };
}

function interactiveTest() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log('\n=== Interactive Test Commands ===');
  console.log('  n <client_idx> <url>  - Client #n creates new page');
  console.log('  c <client_idx>        - Client #n closes current page');
  console.log('  s <client_idx>        - Client #n scrolls page');
  console.log('  l                     - List all clients');
  console.log('  q                     - Quit');
  console.log('================================\n');
  
  rl.on('line', (input) => {
    const parts = input.trim().split(' ');
    const cmd = parts[0];
    
    if (cmd === 'q') {
      console.log('Closing all clients...');
      clients.forEach(c => c.close());
      setTimeout(() => process.exit(0), 500);
    } else if (cmd === 'l') {
      console.log(`Active clients: ${clients.length}`);
      clients.forEach((c, i) => {
        console.log(`  #${i + 1}: ${c.clientId} - ${c.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'}`);
      });
    } else if (cmd === 'n' && parts.length >= 3) {
      const idx = parseInt(parts[1]) - 1;
      const url = parts[2] || 'https://www.baidu.com';
      if (clients[idx]) {
        console.log(`Client #${idx + 1} creating page: ${url}`);
        clients[idx].send('Target.createTarget', { url });
      }
    } else if (cmd === 's' && parts.length >= 2) {
      const idx = parseInt(parts[1]) - 1;
      if (clients[idx]) {
        console.log(`Client #${idx + 1} scrolling...`);
        clients[idx].send('Runtime.evaluate', {
          expression: 'window.scrollBy(0, 100)'
        });
      }
    }
  });
}

setTimeout(interactiveTest, 1000);

process.on('SIGINT', () => {
  console.log('\nClosing all clients...');
  clients.forEach(c => c.close());
  process.exit(0);
});

console.log('Usage: node test-multi-client.js [server_url] [num_clients]');
console.log('Example: node test-multi-client.js ws://localhost:9222 2\n');
