// 最简单的标签组测试脚本
// 复制到Chrome扩展的控制台中运行

console.log('=== 最简单的标签组测试 ===');

// 步骤1: 检查API是否可用
console.log('步骤1: 检查API是否可用');
console.log('chrome.tabs.group:', typeof chrome.tabs.group);
console.log('chrome.tabGroups:', chrome.tabGroups);
console.log('chrome.tabGroups.query:', typeof chrome.tabGroups.query);
console.log('chrome.tabGroups.update:', typeof chrome.tabGroups.update);

// 步骤2: 创建一个标签页
console.log('\n步骤2: 创建一个标签页');
chrome.tabs.create({ url: 'https://www.baidu.com/', active: false }, function(tab) {
  console.log('标签页创建成功:', tab.id);
  
  // 步骤3: 等待5秒
  console.log('\n步骤3: 等待5秒...');
  setTimeout(function() {
    console.log('等待完成，开始创建标签组...');
    
    // 步骤4: 创建标签组
    console.log('\n步骤4: 创建标签组');
    chrome.tabs.group({ tabIds: tab.id }, function(groupId) {
      if (chrome.runtime.lastError) {
        console.error('创建标签组失败:', chrome.runtime.lastError.message);
        return;
      }
      
      console.log('标签组创建成功，组ID:', groupId);
      
      // 步骤5: 更新标签组
      console.log('\n步骤5: 更新标签组');
      chrome.tabGroups.update(groupId, {
        title: 'Test',
        color: 'blue'
      }, function(group) {
        if (chrome.runtime.lastError) {
          console.error('更新标签组失败:', chrome.runtime.lastError.message);
          return;
        }
        
        console.log('标签组更新成功:', group);
        
        // 步骤6: 查询所有标签组
        console.log('\n步骤6: 查询所有标签组');
        chrome.tabGroups.query({}, function(groups) {
          console.log('所有标签组:', groups);
          console.log('\n=== 测试完成 ===');
          console.log('请检查Chrome浏览器中是否有一个名为"Test"的蓝色标签组');
        });
      });
    });
  }, 5000);
});