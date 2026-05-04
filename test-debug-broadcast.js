const WebSocket = require('ws');

// 连接到代理服务器
const ws = new WebSocket('ws://localhost:9221/client');

ws.on('open', () => {
  console.log('[TEST] Connected to proxy server');
  
  // 启用 Target 域来接收 targetCreated 事件
  ws.send(JSON.stringify({
    id: 1,
    method: 'Target.setDiscoverTargets',
    params: { discover: true }
  }));
  
  console.log('[TEST] Sent Target.setDiscoverTargets');
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    
    // 只打印 Target 相关的事件
    if (msg.method && msg.method.startsWith('Target.')) {
      console.log('[EVENT]', msg.method, {
        targetId: msg.params?.targetInfo?.targetId?.substring(0, 8),
        type: msg.params?.targetInfo?.type,
        url: msg.params?.targetInfo?.url?.substring(0, 50)
      });
    }
  } catch (e) {
    console.log('[RAW]', data.toString().substring(0, 100));
  }
});

ws.on('close', (code, reason) => {
  console.log('[TEST] Connection closed:', code, reason.toString());
});

ws.on('error', (err) => {
  console.error('[TEST] Error:', err.message);
});

// 30秒后关闭
setTimeout(() => {
  console.log('[TEST] Closing connection...');
  ws.close();
  process.exit(0);
}, 30000);

console.log('[TEST] Waiting for Target events...');
console.log('[TEST] Please open a new tab manually in Chrome');
