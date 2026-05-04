// 测试标签分组功能的脚本
// 复制到Chrome扩展的控制台中运行

// 1. 测试查询现有标签组
console.log('Testing tab group functionality...');
chrome.tabGroups.query({ title: 'lo' }, function(groups) {
  console.log('Found tab groups:', groups);
  
  // 2. 测试创建新标签
  chrome.tabs.create({ url: 'https://www.baidu.com/', active: false }, function(tab) {
    console.log('Created tab:', tab);
    
    if (groups.length > 0) {
      // 添加到现有组
      console.log('Adding tab to existing group...');
      chrome.tabs.group({ tabIds: tab.id, groupId: groups[0].id }, function(groupId) {
        console.log('Added tab to group:', groupId);
      });
    } else {
      // 创建新组并添加标签页
      console.log('Creating new group and adding tab...');
      chrome.tabs.group({ tabIds: tab.id }, function(groupId) {
        console.log('Created group:', groupId);
        // 更新组的标题和颜色
        if (groupId) {
          chrome.tabGroups.update(groupId, {
            title: 'lo',
            color: 'blue'
          }, function(group) {
            console.log('Updated group:', group);
          });
        }
      });
    }
  });
});

// 3. 测试现有标签的分组
chrome.tabs.query({ active: true }, function(tabs) {
  if (tabs.length > 0) {
    console.log('Current active tab:', tabs[0]);
    
    chrome.tabGroups.query({ title: 'lo' }, function(groups) {
      if (groups.length > 0) {
        console.log('Adding current tab to group...');
        chrome.tabs.group({ tabIds: tabs[0].id, groupId: groups[0].id }, function(groupId) {
          console.log('Added current tab to group:', groupId);
        });
      }
    });
  }
});