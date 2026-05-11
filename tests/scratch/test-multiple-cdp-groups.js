const { chromium } = require('playwright');

async function testMultipleCDPGroups() {
  console.log('=== 测试多个CDP连接的标签分组功能 ===\n');
  
  try {
    // 第一个CDP连接
    console.log('创建第一个CDP连接...');
    const browser1 = await chromium.connectOverCDP('http://localhost:9221');
    console.log('第一个CDP连接成功');
    
    // 创建第一个连接的标签页
    console.log('第一个连接：创建第一个标签页...');
    const page1_1 = await browser1.newPage();
    await page1_1.goto('https://www.baidu.com/');
    await page1_1.waitForTimeout(3000);
    console.log('第一个连接：第一个标签页创建完成');
    
    // 创建第二个标签页
    console.log('第一个连接：创建第二个标签页...');
    const page1_2 = await browser1.newPage();
    await page1_2.goto('https://www.google.com/');
    await page1_2.waitForTimeout(3000);
    console.log('第一个连接：第二个标签页创建完成');
    
    // 等待一段时间，确保标签页被添加到组中
    console.log('等待5秒，确保标签页被添加到组中...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 关闭第一个连接
    console.log('关闭第一个CDP连接...');
    await browser1.close();
    console.log('第一个CDP连接已关闭');
    
    // 等待一段时间
    console.log('等待3秒...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 第二个CDP连接
    console.log('\n创建第二个CDP连接...');
    const browser2 = await chromium.connectOverCDP('http://localhost:9221');
    console.log('第二个CDP连接成功');
    
    // 创建第二个连接的标签页
    console.log('第二个连接：创建第一个标签页...');
    const page2_1 = await browser2.newPage();
    await page2_1.goto('https://www.github.com/');
    await page2_1.waitForTimeout(3000);
    console.log('第二个连接：第一个标签页创建完成');
    
    // 创建第二个标签页
    console.log('第二个连接：创建第二个标签页...');
    const page2_2 = await browser2.newPage();
    await page2_2.goto('https://www.stackoverflow.com/');
    await page2_2.waitForTimeout(3000);
    console.log('第二个连接：第二个标签页创建完成');
    
    // 等待一段时间，确保标签页被添加到组中
    console.log('等待5秒，确保标签页被添加到组中...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 关闭第二个连接
    console.log('关闭第二个CDP连接...');
    await browser2.close();
    console.log('第二个CDP连接已关闭');
    
    console.log('\n=== 测试完成 ===');
    console.log('请检查Chrome浏览器中的标签组：');
    console.log('1. 第一个CDP连接应该创建了一个标签组，包含百度和Google两个标签页');
    console.log('2. 第二个CDP连接应该创建了另一个标签组，包含GitHub和Stack Overflow两个标签页');
    console.log('3. 两个标签组应该有不同的名称和颜色');
    
  } catch (error) {
    console.error('测试过程中出现错误:', error);
  }
}

testMultipleCDPGroups();