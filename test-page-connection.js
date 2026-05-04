const WebSocket = require('ws');

const TARGET_ID = '4724AF3A60A419ECDEC2002A153733A2'; // 百度首页

console.log('[Page Test] Connecting to specific page...');

const ws = new WebSocket(`ws://localhost:9221/devtools/page/${TARGET_ID}`);

ws.on('open', () => {
  console.log('[Page Test] Connected to page!');
  
  ws.send(JSON.stringify({
    id: 1,
    method: 'Page.enable',
    params: {}
  }));
  
  console.log('[Page Test] Enabled Page domain');
  
  setTimeout(() => {
    ws.send(JSON.stringify({
      id: 2,
      method: 'Runtime.evaluate',
      params: {
        expression: 'document.title'
      }
    }));
    console.log('[Page Test] Getting page title...');
  }, 500);
  
  setTimeout(() => {
    ws.send(JSON.stringify({
      id: 3,
      method: 'Page.captureScreenshot',
      params: {}
    }));
    console.log('[Page Test] Taking screenshot...');
  }, 1000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    
    if (msg.id) {
      console.log('[Page Test] Response #' + msg.id + ':', {
        success: !!msg.result,
        error: msg.error,
        result: msg.result?.result?.value || 
                (msg.result?.data ? `screenshot (${msg.result.data.length} chars)` : undefined)
      });
    } else if (msg.method) {
      console.log('[Page Test] Event:', msg.method);
    } else {
      console.log('[Page Test] Other message:', msg);
    }
  } catch (e) {
    console.log('[Page Test] Raw message:', data.toString().substring(0, 100));
  }
});

ws.on('close', (code, reason) => {
  console.log('[Page Test] Connection closed:', code, reason.toString());
});

ws.on('error', (err) => {
  console.error('[Page Test] Error:', err.message);
});

setTimeout(() => {
  console.log('\n[Page Test] Test completed, closing connection...');
  ws.close();
  process.exit(0);
}, 3000);
