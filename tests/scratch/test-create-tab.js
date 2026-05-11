const WebSocket = require('ws');
const http = require('http');

async function test() {
  // 创建本地服务器
  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Test</title></head>
    <body>
      <h1>Test Page</h1>
      <a href="about:blank" target="_blank" id="link">Open New Tab</a>
    </body>
    </html>
  `;
  
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  
  await new Promise(r => server.listen(9999, r));
  console.log('Server: http://localhost:9999');
  
  // 连接到 CDP Tunnel
  console.log('\nConnecting to CDP Tunnel...');
  const ws = new WebSocket('ws://localhost:9221/client');
  
  let targetCreatedCount = 0;
  
  ws.on('open', () => {
    console.log('Connected!');
    
    // 1. 获取所有 targets
    ws.send(JSON.stringify({
      id: 1,
      method: 'Target.getTargets',
      params: {}
    }));
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // 打印所有 Target 相关事件
      if (msg.method && msg.method.startsWith('Target.')) {
        console.log('[EVENT]', msg.method);
        if (msg.method === 'Target.targetCreated') {
          targetCreatedCount++;
          console.log('  targetId:', msg.params?.targetInfo?.targetId?.substring(0, 8));
          console.log('  type:', msg.params?.targetInfo?.type);
          console.log('  url:', msg.params?.targetInfo?.url?.substring(0, 50));
        }
      }
      
      // 收到 getTargets 响应后，启用 discover
      if (msg.id === 1 && msg.result) {
        console.log('\nGot', msg.result.targetInfos.length, 'targets');
        
        // 2. 启用 Target.setDiscoverTargets
        ws.send(JSON.stringify({
          id: 2,
          method: 'Target.setDiscoverTargets',
          params: { discover: true }
        }));
        console.log('Sent Target.setDiscoverTargets');
      }
      
      // 收到 setDiscoverTargets 响应后，创建新 target
      if (msg.id === 2 && msg.result !== undefined) {
        console.log('\nDiscover enabled, creating new target...');
        
        // 3. 创建新 target
        setTimeout(() => {
          ws.send(JSON.stringify({
            id: 3,
            method: 'Target.createTarget',
            params: { url: 'http://localhost:9999' }
          }));
          console.log('Sent Target.createTarget');
        }, 1000);
      }
      
      // 收到 createTarget 响应
      if (msg.id === 3 && msg.result) {
        console.log('\nNew target created:', msg.result.targetId?.substring(0, 8));
        
        // 等待一段时间，看看是否收到 targetCreated 事件
        setTimeout(() => {
          console.log('\n=== RESULTS ===');
          console.log('Target.targetCreated events received:', targetCreatedCount);
          ws.close();
          server.close();
        }, 3000);
      }
      
    } catch (e) {
      console.log('[ERROR]', e.message);
    }
  });
  
  ws.on('close', () => {
    console.log('Connection closed');
    process.exit(0);
  });
  
  ws.on('error', (err) => {
    console.error('Error:', err.message);
  });
}

test();
