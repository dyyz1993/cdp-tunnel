// 完整的标签分组测试脚本
// 复制到Chrome扩展的控制台中运行

console.log('=== 开始测试标签分组功能 ===');

// 1. 测试1：创建新标签并添加到lo组
function test1_CreateTabAndAddToGroup() {
  console.log('\n=== 测试1：创建新标签并添加到lo组 ===');
  
  // 先查询是否存在lo组
  chrome.tabGroups.query({ title: 'lo' }, function(groups) {
    console.log('找到的标签组:', groups);
    
    // 创建新标签页
    chrome.tabs.create({ url: 'https://www.baidu.com/', active: false }, function(tab) {
      console.log('创建的标签页:', tab);
      
      if (groups.length > 0) {
        // 如果存在lo组，直接添加
        console.log('将标签页添加到现有lo组');
        chrome.tabs.group({ tabIds: tab.id, groupId: groups[0].id }, function(groupId) {
          console.log('标签页已添加到组:', groupId);
          test2_AddExistingTabToGroup();
        });
      } else {
        // 如果不存在lo组，创建新组
        console.log('创建新的lo组并添加标签页');
        chrome.tabs.group({ tabIds: tab.id }, function(groupId) {
          console.log('创建的组ID:', groupId);
          // 更新组的标题和颜色
          chrome.tabGroups.update(groupId, {
            title: 'lo',
            color: 'blue'
          }, function(group) {
            console.log('更新后的组:', group);
            test2_AddExistingTabToGroup();
          });
        });
      }
    });
  });
}

// 2. 测试2：将现有标签添加到lo组
function test2_AddExistingTabToGroup() {
  console.log('\n=== 测试2：将现有标签添加到lo组 ===');
  
  // 获取当前活动标签
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    if (tabs.length > 0) {
      var activeTab = tabs[0];
      console.log('当前活动标签:', activeTab);
      
      // 查询lo组
      chrome.tabGroups.query({ title: 'lo' }, function(groups) {
        if (groups.length > 0) {
          console.log('将当前标签添加到lo组');
          chrome.tabs.group({ tabIds: activeTab.id, groupId: groups[0].id }, function(groupId) {
            console.log('当前标签已添加到组:', groupId);
            test3_VerifyGroupMembers();
          });
        } else {
          console.log('未找到lo组');
          test3_VerifyGroupMembers();
        }
      });
    } else {
      console.log('未找到活动标签');
      test3_VerifyGroupMembers();
    }
  });
}

// 3. 测试3：验证lo组的成员
function test3_VerifyGroupMembers() {
  console.log('\n=== 测试3：验证lo组的成员 ===');
  
  // 查询lo组
  chrome.tabGroups.query({ title: 'lo' }, function(groups) {
    if (groups.length > 0) {
      var loGroup = groups[0];
      console.log('lo组信息:', loGroup);
      
      // 查询组内的标签
      chrome.tabs.query({ groupId: loGroup.id }, function(tabs) {
        console.log('lo组内的标签:', tabs);
        console.log('lo组内标签数量:', tabs.length);
        
        // 打印每个标签的信息
        tabs.forEach(function(tab, index) {
          console.log('标签', index + 1, ':', tab.title, '-', tab.url);
        });
        
        console.log('\n=== 测试完成 ===');
        console.log('请检查Chrome浏览器中的标签组是否正确创建，并且标签页是否被正确添加到组中。');
      });
    } else {
      console.log('未找到lo组');
      console.log('\n=== 测试完成 ===');
    }
  });
}

// 开始执行测试
test1_CreateTabAndAddToGroup();