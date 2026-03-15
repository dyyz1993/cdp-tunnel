document.addEventListener('DOMContentLoaded', function() {
  var statusDot = document.getElementById('statusDot');
  var statusText = document.getElementById('statusText');
  var wsAddressInput = document.getElementById('wsAddress');
  var saveBtn = document.getElementById('saveBtn');

  chrome.storage.local.get(['wsAddress'], function(result) {
    if (result.wsAddress) {
      wsAddressInput.value = result.wsAddress;
    } else {
      wsAddressInput.value = 'ws://localhost:9221/plugin';
    }
  });

  saveBtn.addEventListener('click', function() {
    var newAddress = wsAddressInput.value.trim();
    if (newAddress) {
      chrome.storage.local.set({ wsAddress: newAddress }, function() {
        statusText.textContent = '已保存，正在重连...';
        
        chrome.runtime.sendMessage({ type: 'reconnect' }, function(response) {
          if (response && response.success) {
            statusText.textContent = '已激活';
          } else {
            statusText.textContent = '重连失败';
          }
        });
      });
    }
  });

  statusDot.classList.add('active');
  statusText.textContent = '已激活';
});
