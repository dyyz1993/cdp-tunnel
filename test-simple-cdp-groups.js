const { chromium } = require('playwright');

async function testSimpleCDPGroups() {
  console.log('=== 简单测试CDP连接的标签分组功能 ===\n');
  
  try {
    // 创建CDP连接
    console.log('创建CDP连接...');
    const browser = await chromium.connectOverCDP('http://localhost:9221');
    console.log('CDP连接成功');
    
    // 创建第一个标签页
    console.log('创建第一个标签页...');
    const page1 = await browser.newPage();
    console.log('第一个标签页创建完成');
    
    // 等待一段时间
    console.log('等待5秒...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 创建第二个标签页
    console.log('创建第二个标签页...');
    const page2 = await browser.newPage();
    console.log('第二个标签页创建完成');
    
    // 等待一段时间
    console.log('等待5秒...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('\n=== 测试完成 ===');
    console.log('请检查Chrome浏览器中的标签组：');
    console.log('1. 应该创建了一个名为"CDP-{客户端ID}"的标签组');
    console.log('2. 两个标签页应该被添加到该组中');
    
    // 不关闭浏览器，让用户手动检查
    console.log('\n测试脚本完成，浏览器连接保持打开状态，请手动检查标签组。');
    console.log('按Ctrl+C退出脚本...');
    
  } catch (error) {
    console.error('测试过程中出现错误:', error);
  }
}

testSimpleCDPGroups();