const WebSocket = require('ws');

const SERVER_URL = 'ws://localhost:9221/client';

console.log('[Test] Connecting to CDP proxy server...');

const ws = new WebSocket(SERVER_URL);

ws.on('open', () => {
  console.log('[Test] Connected to server!');
  
  ws.send(JSON.stringify({
    id: 1,
    method: 'Target.setDiscoverTargets',
    params: { discover: true }
  }));
  
  console.log('[Test] Sent Target.setDiscoverTargets');
  
  setTimeout(() => {
    ws.send(JSON.stringify({
      id: 2,
      method: 'Target.getTargets',
      params: {}
    }));
    console.log('[Test] Sent Target.getTargets');
  }, 1000);
  
  setTimeout(() => {
    console.log('[Test] Creating new page...');
    ws.send(JSON.stringify({
      id: 3,
      method: 'Target.createTarget',
      params: { url: 'https://www.example.com' }
    }));
  }, 2000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'connected') {
      console.log('[Test] Server acknowledged connection:', msg);
    } else if (msg.method && msg.method.startsWith('Target.')) {
      console.log('[Test] Target event:', msg.method, {
        targetId: msg.params?.targetInfo?.targetId?.substring(0, 8),
        url: msg.params?.targetInfo?.url,
        type: msg.params?.targetInfo?.type
      });
    } else if (msg.id) {
      console.log('[Test] Response to request #' + msg.id + ':', {
        success: !!msg.result,
        error: msg.error,
        targetId: msg.result?.targetId?.substring(0, 8),
        targetCount: msg.result?.targetInfos?.length
      });
      
      if (msg.result?.targetInfos) {
        console.log('[Test] Found targets:');
        msg.result.targetInfos.slice(0, 5).forEach((t, i) => {
          console.log(`  ${i + 1}. ${t.type}: ${t.url?.substring(0, 50)}`);
        });
      }
    } else {
      console.log('[Test] Other message:', msg.type || msg.method);
    }
  } catch (e) {
    console.log('[Test] Raw message:', data.toString().substring(0, 100));
  }
});

ws.on('close', (code, reason) => {
  console.log('[Test] Connection closed:', code, reason.toString());
});

ws.on('error', (err) => {
  console.error('[Test] Error:', err.message);
});

setTimeout(() => {
  console.log('\n[Test] Test completed, closing connection...');
  ws.close();
  process.exit(0);
}, 5000);
