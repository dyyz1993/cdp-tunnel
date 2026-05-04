const WebSocket = require('ws');

async function testPlaywrightConnectionSequence() {
  console.log('[Sequence Test] Simulating Playwright connection sequence...\n');
  
  const ws = new WebSocket('ws://localhost:9221/client');
  
  let requestId = 1;
  
  const sendRequest = (method, params = {}) => {
    const id = requestId++;
    const msg = { id, method, params };
    console.log(`[SEND] #${id}: ${method}`, params);
    ws.send(JSON.stringify(msg));
    return id;
  };
  
  ws.on('open', async () => {
    console.log('[Sequence Test] Connected!\n');
    
    console.log('Step 1: Enable Target domain');
    sendRequest('Target.setDiscoverTargets', { discover: true });
    
    await sleep(500);
    
    console.log('\nStep 2: Get all targets');
    sendRequest('Target.getTargets');
    
    await sleep(1000);
    
    console.log('\nStep 3: Attach to first page target');
    sendRequest('Target.attachToTarget', {
      targetId: '4724AF3A60A419ECDEC2002A153733A2', // 百度首页
      flatten: true
    });
    
    await sleep(1000);
    
    console.log('\nStep 4: Enable Page domain on attached target');
    sendRequest('Page.enable');
    
    await sleep(500);
    
    console.log('\nStep 5: Navigate the page');
    sendRequest('Page.navigate', { url: 'https://www.example.com' });
    
    await sleep(2000);
    
    console.log('\n[Sequence Test] Test completed');
    ws.close();
    process.exit(0);
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.id) {
        console.log(`[RECV] #${msg.id}:`, JSON.stringify(msg, null, 2).substring(0, 300));
      } else if (msg.method) {
        console.log(`[EVENT] ${msg.method}:`, {
          targetId: msg.params?.targetInfo?.targetId?.substring(0, 8),
          sessionId: msg.params?.sessionId?.substring(0, 8),
          url: msg.params?.targetInfo?.url?.substring(0, 50)
        });
      }
    } catch (e) {
      console.log('[RECV] Raw:', data.toString().substring(0, 100));
    }
  });
  
  ws.on('error', (err) => {
    console.error('[ERROR]', err.message);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testPlaywrightConnectionSequence();
