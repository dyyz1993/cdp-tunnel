const WebSocket = require('ws');

async function testCDPGroups() {
  console.log('=== 测试CDP连接的标签分组功能 ===\n');
  
  try {
    // 连接到CDP服务器
    console.log('连接到CDP服务器...');
    const ws = new WebSocket('ws://localhost:9221/client');
    
    ws.on('open', async function() {
      console.log('CDP连接成功');
      
      // 创建第一个标签页
      console.log('创建第一个标签页...');
      ws.send(JSON.stringify({
        id: 1,
        method: 'Target.createTarget',
        params: {
          url: 'https://www.baidu.com/'
        }
      }));
      
      // 等待5秒
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 创建第二个标签页
      console.log('创建第二个标签页...');
      ws.send(JSON.stringify({
        id: 2,
        method: 'Target.createTarget',
        params: {
          url: 'https://www.google.com/'
        }
      }));
      
      // 等待5秒
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('\n=== 测试完成 ===');
      console.log('请检查Chrome浏览器中的标签组：');
      console.log('1. 应该创建了一个名为"CDP-{客户端ID}"的标签组');
      console.log('2. 两个标签页应该被添加到该组中');
      
      // 关闭连接
      ws.close();
    });
    
    ws.on('message', function(data) {
      try {
        const message = JSON.parse(data);
        console.log('收到消息:', message);
      } catch (e) {
        console.error('解析消息失败:', e);
      }
    });
    
    ws.on('error', function(error) {
      console.error('WebSocket错误:', error);
    });
    
    ws.on('close', function() {
      console.log('WebSocket连接已关闭');
    });
    
  } catch (error) {
    console.error('测试过程中出现错误:', error);
  }
}

testCDPGroups();