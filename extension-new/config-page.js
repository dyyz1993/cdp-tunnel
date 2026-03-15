(function() {
  var state = {
    connected: false,
    serverAddress: 'ws://localhost:9221/plugin',
    cdpClients: [],
    attachedPages: [],
    logs: [],
    startTime: Date.now(),
    cdpCommandCount: 0
  };

  var elements = {
    statusBadge: document.getElementById('statusBadge'),
    statusText: document.getElementById('statusText'),
    activeConnections: document.getElementById('activeConnections'),
    controlledPages: document.getElementById('controlledPages'),
    cdpCommands: document.getElementById('cdpCommands'),
    uptime: document.getElementById('uptime'),
    clientCount: document.getElementById('clientCount'),
    pageCount: document.getElementById('pageCount'),
    clientList: document.getElementById('clientList'),
    pageList: document.getElementById('pageList'),
    activityLog: document.getElementById('activityLog'),
    serverAddress: document.getElementById('serverAddress'),
    connectBtn: document.getElementById('connectBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    toast: document.getElementById('toast')
  };

  function showToast(message, type) {
    type = type || 'success';
    var icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    elements.toast.querySelector('.icon').textContent = icon;
    elements.toast.querySelector('.message').textContent = message;
    elements.toast.className = 'toast show ' + type;
    setTimeout(function() {
      elements.toast.className = 'toast';
    }, 2000);
  }

  function updateStatus(connected) {
    state.connected = connected;
    if (connected) {
      elements.statusBadge.classList.remove('disconnected');
      elements.statusText.textContent = '已连接';
    } else {
      elements.statusBadge.classList.add('disconnected');
      elements.statusText.textContent = '未连接';
    }
  }

  function updateStats() {
    elements.activeConnections.textContent = state.cdpClients.length;
    elements.controlledPages.textContent = state.attachedPages.length;
    elements.cdpCommands.textContent = state.cdpCommandCount;
    
    var elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    if (elapsed < 60) {
      elements.uptime.textContent = elapsed + 's';
    } else if (elapsed < 3600) {
      elements.uptime.textContent = Math.floor(elapsed / 60) + 'm';
    } else {
      elements.uptime.textContent = Math.floor(elapsed / 3600) + 'h ' + Math.floor((elapsed % 3600) / 60) + 'm';
    }
    
    elements.clientCount.textContent = state.cdpClients.length + ' 个';
    elements.pageCount.textContent = state.attachedPages.length + ' 个';
  }

  function renderClients() {
    if (state.cdpClients.length === 0) {
      elements.clientList.innerHTML = 
        '<div class="empty-state">' +
          '<div class="icon">🔌</div>' +
          '<div class="title">暂无客户端</div>' +
          '<div class="desc">等待 Playwright/Puppeteer 连接...</div>' +
        '</div>';
      return;
    }

    var html = '';
    state.cdpClients.forEach(function(client) {
      var clientId = client.id || '';
      var shortId = clientId.length > 25 ? clientId.substring(0, 25) + '...' : clientId;
      var connectedAt = client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString() : 'N/A';
      
      html += 
        '<div class="connection-item active">' +
          '<div class="status-indicator online"></div>' +
          '<div class="connection-info">' +
            '<div class="connection-header">' +
              '<span class="connection-name" title="' + clientId + '">' + shortId + '</span>' +
              '<span class="connection-tag playwright">CDP</span>' +
            '</div>' +
            '<div class="connection-details">' +
              '<span>🔗 Playwright/Puppeteer</span>' +
              '<span>⏰ ' + connectedAt + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    });
    elements.clientList.innerHTML = html;
  }

  function renderPages() {
    if (state.attachedPages.length === 0) {
      elements.pageList.innerHTML = 
        '<div class="empty-state">' +
          '<div class="icon">📄</div>' +
          '<div class="title">暂无页面</div>' +
          '<div class="desc">客户端创建页面后会显示在这里</div>' +
        '</div>';
      return;
    }

    var html = '';
    state.attachedPages.forEach(function(page) {
      var pageUrl = page.url || '';
      var displayUrl = pageUrl.length > 35 ? pageUrl.substring(0, 35) + '...' : pageUrl;
      var pageTitle = page.title || 'Untitled';
      
      html += 
        '<div class="connection-item active">' +
          '<div class="status-indicator online"></div>' +
          '<div class="connection-info">' +
            '<div class="connection-header">' +
              '<span class="connection-name" title="' + pageTitle + '">' + pageTitle + '</span>' +
              '<span class="connection-tag cdp">Tab #' + page.tabId + '</span>' +
            '</div>' +
            '<div class="connection-details">' +
              '<span title="' + pageUrl + '">' + displayUrl + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="connection-actions">' +
            '<button class="action-btn" title="切换到此标签页" data-tabid="' + page.tabId + '">👁️</button>' +
          '</div>' +
        '</div>';
    });
    elements.pageList.innerHTML = html;
  }

  function renderLogs() {
    if (state.logs.length === 0) {
      elements.activityLog.innerHTML = 
        '<div class="empty-state">' +
          '<div class="icon">📋</div>' +
          '<div class="title">暂无日志</div>' +
          '<div class="desc">活动将显示在这里</div>' +
        '</div>';
      return;
    }

    var html = '';
    state.logs.slice(0, 20).forEach(function(log) {
      html += 
        '<div class="log-item">' +
          '<div class="log-icon ' + log.type + '">' + log.icon + '</div>' +
          '<div class="log-content">' +
            '<div class="log-message">' + log.message + '</div>' +
            '<div class="log-time">' + log.time + '</div>' +
          '</div>' +
        '</div>';
    });
    elements.activityLog.innerHTML = html;
  }

  function addLog(type, message) {
    var icons = {
      connect: '✓',
      disconnect: '✕',
      action: '⚡',
      page: '📄'
    };
    
    state.logs.unshift({
      type: type,
      icon: icons[type] || '•',
      message: message,
      time: new Date().toLocaleTimeString()
    });
    
    renderLogs();
  }

  function fetchState() {
    return new Promise(function(resolve) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          chrome.runtime.sendMessage({ type: 'getState' }, function(response) {
            if (response) {
              state.connected = response.connected || false;
              state.serverAddress = response.serverAddress || state.serverAddress;
              state.cdpClients = response.cdpClients || [];
              state.attachedPages = response.attachedPages || [];
              elements.serverAddress.value = state.serverAddress;
              updateStatus(state.connected);
              updateStats();
              renderClients();
              renderPages();
              resolve(true);
              return;
            }
            resolve(false);
          });
          return;
        }
      } catch (e) {
        console.error('[Config] Failed to fetch state:', e);
      }
      
      updateStatus(false);
      updateStats();
      renderClients();
      renderPages();
      resolve(false);
    });
  }

  function saveAndConnect() {
    var address = elements.serverAddress.value.trim();
    
    if (!address) {
      showToast('请输入服务器地址', 'error');
      return;
    }
    
    state.serverAddress = address;
    
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ wsAddress: address });
    }
    
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      try {
        chrome.runtime.sendMessage({ 
          type: 'connect',
          serverAddress: address 
        });
        showToast('正在连接...');
      } catch (e) {
        showToast('连接请求发送失败', 'error');
      }
    } else {
      showToast('请在扩展环境中使用', 'error');
    }
  }

  function refresh() {
    fetchState();
    showToast('已刷新');
  }

  function init() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get('wsAddress', function(result) {
        if (result.wsAddress) {
          state.serverAddress = result.wsAddress;
          elements.serverAddress.value = result.wsAddress;
        }
      });
    }
    
    fetchState();
    
    setInterval(fetchState, 5000);
    setInterval(updateStats, 1000);
  }

  elements.connectBtn.addEventListener('click', saveAndConnect);
  elements.refreshBtn.addEventListener('click', refresh);
  
  elements.pageList.addEventListener('click', function(e) {
    var btn = e.target.closest('.action-btn');
    if (btn) {
      var tabId = parseInt(btn.dataset.tabid);
      if (tabId) {
        chrome.tabs.update(tabId, { active: true });
        chrome.tabs.get(tabId, function(tab) {
          if (tab && tab.windowId) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
        });
      }
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (message.type === 'stateUpdate') {
        var wasConnected = state.connected;
        state.connected = message.connected;
        state.cdpClients = message.cdpClients || [];
        state.attachedPages = message.attachedPages || [];
        updateStatus(state.connected);
        updateStats();
        renderClients();
        renderPages();
        
        if (state.connected && !wasConnected) {
          addLog('connect', '已连接到服务器');
        } else if (!state.connected && wasConnected) {
          addLog('disconnect', '已断开连接');
        }
        
        if (state.cdpClients.length > 0) {
          addLog('connect', state.cdpClients.length + ' 个 CDP 客户端在线');
        }
        if (state.attachedPages.length > 0) {
          addLog('page', state.attachedPages.length + ' 个页面受控');
        }
      } else if (message.type === 'log') {
        addLog(message.logType, message.message);
      }
    });
  }

  init();
})();
