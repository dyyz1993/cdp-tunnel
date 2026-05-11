// 简单测试标签分组功能
// 复制到Chrome扩展的控制台中运行

console.log('=== 测试标签分组功能 ===');

// 创建第一个标签页
chrome.tabs.create({ url: 'https://www.baidu.com/', active: false }, function(tab1) {
  console.log('创建第一个标签页:', tab1.id);
  
  // 等待2秒后创建组
  setTimeout(function() {
    console.log('尝试创建标签组...');
    
    // 创建新组
    chrome.tabs.group({ tabIds: tab1.id }, function(groupId) {
      if (chrome.runtime.lastError) {
        console.error('创建组失败:', chrome.runtime.lastError.message);
        return;
      }
      
      console.log('创建的组ID:', groupId);
      
      // 更新组的标题和颜色
      chrome.tabGroups.update(groupId, {
        title: 'CDP-Test',
        color: 'blue'
      }, function(group) {
        if (chrome.runtime.lastError) {
          console.error('更新组失败:', chrome.runtime.lastError.message);
        } else {
          console.log('组创建并更新成功:', group);
          
          // 创建第二个标签页
          chrome.tabs.create({ url: 'https://www.google.com/', active: false }, function(tab2) {
            console.log('创建第二个标签页:', tab2.id);
            
            // 等待2秒后添加到组
            setTimeout(function() {
              console.log('将第二个标签页添加到组...');
              chrome.tabs.group({ tabIds: tab2.id, groupId: groupId }, function(resultGroupId) {
                if (chrome.runtime.lastError) {
                  console.error('添加标签页到组失败:', chrome.runtime.lastError.message);
                } else {
                  console.log('标签页已添加到组:', resultGroupId);
                  
                  // 查询所有标签组
                  chrome.tabGroups.query({}, function(groups) {
                    console.log('所有标签组:', groups);
                  });
                }
              });
            }, 2000);
          });
        }
      });
    });
  }, 2000);
});