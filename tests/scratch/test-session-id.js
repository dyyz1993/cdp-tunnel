const WebSocket = require('ws');

async function testWithSessionId() {
  console.log('[Session Test] Testing with proper sessionId handling...\n');
  
  const ws = new WebSocket('ws://localhost:9221/client');
  
  let requestId = 1;
  let currentSessionId = null;
  
  const sendRequest = (method, params = {}, sessionId = null) => {
    const id = requestId++;
    const msg = { id, method, params };
    if (sessionId) {
      msg.sessionId = sessionId;
    }
    console.log(`[SEND] #${id}: ${method}${sessionId ? ` (session: ${sessionId.substring(0, 8)})` : ''}`);
    ws.send(JSON.stringify(msg));
    return id;
  };
  
  ws.on('open', async () => {
    console.log('[Session Test] Connected!\n');
    
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
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.id) {
        console.log(`[RECV] #${msg.id}:`, JSON.stringify(msg, null, 2).substring(0, 400));
        
        if (msg.result && msg.result.sessionId) {
          currentSessionId = msg.result.sessionId;
          console.log(`\n*** Got sessionId: ${currentSessionId.substring(0, 8)} ***\n`);
          
          setTimeout(async () => {
            console.log('Step 4: Enable Page domain on attached target (with sessionId)');
            sendRequest('Page.enable', {}, currentSessionId);
            
            await sleep(500);
            
            console.log('\nStep 5: Navigate the page (with sessionId)');
            sendRequest('Page.navigate', { url: 'https://www.example.com' }, currentSessionId);
            
            await sleep(2000);
            
            console.log('\n[Session Test] Test completed');
            ws.close();
            process.exit(0);
          }, 500);
        }
      } else if (msg.method) {
        console.log(`[EVENT] ${msg.method}:`, {
          sessionId: msg.sessionId?.substring(0, 8) || 'none',
          params: JSON.stringify(msg.params).substring(0, 100)
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

testWithSessionId();
