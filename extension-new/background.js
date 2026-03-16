importScripts('utils/config.js');
importScripts('utils/logger.js');
importScripts('utils/helpers.js');
importScripts('utils/diagnostics.js');
importScripts('core/state.js');
importScripts('core/websocket.js');
importScripts('core/debugger.js');
importScripts('cdp/response.js');
importScripts('cdp/handler/local.js');
importScripts('cdp/handler/special.js');
importScripts('cdp/handler/forward.js');
importScripts('cdp/index.js');
importScripts('features/screencast.js');
importScripts('features/automation-badge.js');

(function() {
  'use strict';

  var keepAliveInterval = null;

  function startKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    
    keepAliveInterval = setInterval(function() {
      var ws = State.getWs();
      if (ws && ws.readyState === WebSocket.OPEN) {
        Logger.info('[KeepAlive] Sending heartbeat');
        WebSocketManager.send({ type: 'keepalive', timestamp: Date.now() });
      }
    }, 20000);
    
    Logger.info('[KeepAlive] Started keepalive interval');
  }

  function stopKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
      Logger.info('[KeepAlive] Stopped keepalive interval');
    }
  }

  function init() {
    Logger.info('[Init] CDP Bridge starting...');

    // 点击扩展图标时打开配置页面
    chrome.action.onClicked.addListener(function(tab) {
      Logger.info('[Action] Extension icon clicked, opening config page');
      chrome.tabs.create({
        url: chrome.runtime.getURL('config-page-preview.html')
      });
    });

    State.loadPersisted().then(function(result) {
      Logger.info('[Init] Loaded persisted state:', result);

      if (result.currentTabId != null) {
        validatePersistedState(result.currentTabId, result.isAttached);
      }

      WebSocketManager.connect();
      startKeepAlive();
      
      setTimeout(function() {
        Diagnostics.start();
      }, 2000);
    });
  }

  function validatePersistedState(tabId, expectedAttached) {
    chrome.tabs.get(tabId, function(tab) {
      if (chrome.runtime.lastError) {
        Logger.info('[Init] Failed to validate persisted state, resetting');
        State.persist(null, false);
        return;
      }
      if (!tab || !tab.id) {
        Logger.info('[Init] Persisted tab no longer exists, resetting state');
        State.persist(null, false);
        return;
      }

      DebuggerManager.getActualAttachState(tabId).then(function(isActuallyAttached) {
        if (expectedAttached && !isActuallyAttached) {
          Logger.info('[Init] Persisted state mismatch, resetting');
          State.persist(null, false);
        }
      }).catch(function() {
        Logger.info('[Init] Failed to get attach state, resetting');
        State.persist(null, false);
      });
    });
  }

  chrome.debugger.onEvent.addListener(function(source, method, params) {
    if (method === 'Runtime.bindingCalled' && params && params.name === '__notifyChange') {
      Screencast.onNotify(source.tabId);
      return;
    }

    DebuggerManager.handleDebuggerEvent(source, method, params);
  });

  chrome.debugger.onDetach.addListener(function(source, reason) {
    DebuggerManager.handleDetach(source, reason);
  });

  chrome.tabs.onRemoved.addListener(function(tabId) {
    Logger.info('[Tabs] Tab removed:', tabId);

    State.removeAttachedTab(tabId);
    Screencast.stopPolling(tabId);
    AutomationBadge.remove(tabId);

    var sessionId = State.findSessionByTabId(tabId);
    if (sessionId) {
      var targetId = State.getTargetIdBySession(sessionId);
      EventBuilder.send('Target.targetDestroyed', { targetId: targetId });
      EventBuilder.send('Target.detachedFromTarget', {
        sessionId: sessionId,
        targetId: targetId
      });
      State.unmapSession(sessionId);
    }

    if (State.getCurrentTabId() === tabId) {
      State.persist(null, false);
    }
  });

  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete' && State.isTabAttached(tabId)) {
      AutomationBadge.inject(tabId);
    }
  });

  chrome.tabs.onCreated.addListener(function(tab) {
    Logger.info('[Tabs] Tab created:', tab.id, tab.url, 'openerTabId:', tab.openerTabId);
    
    if (!State.hasConnectedClient()) {
      Logger.info('[Tabs] No connected client, skipping');
      return;
    }
    
    var tabId = tab.id;
    
    var tabUrl = tab.url || tab.pendingUrl || 'about:blank';
    if (State.hasPendingCreatedTabUrl(tabUrl)) {
      Logger.info('[Tabs] Tab created by Target.createTarget, will be handled by createTarget:', tabUrl);
      State.removePendingCreatedTabUrl(tabUrl);
      return;
    }
    
    var openerTabId = tab.openerTabId;
    var isOpenerControlled = openerTabId && State.isTabAttached(openerTabId);
    
    // 修改逻辑：只要有 opener，就尝试处理（不管 opener 是否被控制）
    // 因为 Playwright 创建的页面 opener 可能没有被扩展识别
    if (!openerTabId) {
      Logger.info('[Tabs] Tab has no opener, skipping. tabId:', tabId);
      return;
    }
    
    Logger.info('[Tabs] Tab has opener:', openerTabId, ', controlled:', isOpenerControlled, ', will attach');
    
    LocalHandler.getTargetInfoById(String(tabId)).then(function(targetInfo) {
      Logger.info('[Tabs] getTargetInfoById result:', targetInfo ? targetInfo.targetId : 'null');
      if (!targetInfo) {
        Logger.error('[Tabs] getTargetInfoById returned null for tabId:', tabId);
        return;
      }
      
      var targetId = targetInfo.targetId;
      Logger.info('[Tabs] targetId:', targetId);
      
      if (State.hasEmittedTarget(targetId)) {
        Logger.info('[Tabs] Target already emitted, skipping:', targetId);
        return;
      }
      
      State.addEmittedTarget(targetId);
      Logger.info('[Tabs] Sending Target.targetCreated event');
      
      EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo });
      Logger.info('[Tabs] Target.targetCreated sent, now attaching to tab:', tabId);
      
      return DebuggerManager.attach(tabId).then(function(attached) {
        Logger.info('[Tabs] DebuggerManager.attach result:', attached);
        if (!attached) {
          Logger.error('[Tabs] Failed to attach to tab:', tabId);
          return;
        }
        
        var sessionId = CDPUtils.generateSessionId();
        State.mapSession(sessionId, tabId, targetId);
        
        AutomationBadge.inject(tabId);
        Logger.info('[Tabs] Sending Target.attachedToTarget event');
        
        EventBuilder.send('Target.attachedToTarget', {
          sessionId: sessionId,
          targetInfo: targetInfo,
          waitingForDebugger: false
        });
        Logger.info('[Tabs] Target.attachedToTarget sent');
      }).catch(function(err) {
        Logger.error('[Tabs] DebuggerManager.attach error:', err);
      });
    }).catch(function(err) {
      Logger.error('[Tabs] getTargetInfoById error:', err);
    });
  });

  chrome.runtime.onInstalled.addListener(function(details) {
    Logger.info('[Runtime] Extension installed/updated:', details.reason);
    State.persist(null, false);
    WebSocketManager.setBadgeStatus('ON');
    init();
  });

  chrome.runtime.onStartup.addListener(function() {
    Logger.info('[Runtime] Browser started');
    init();
  });

  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'reconnect') {
      Logger.info('[Runtime] Received reconnect request from popup');
      var ws = State.getWs();
      if (ws) {
        ws.close();
      }
      WebSocketManager.connect();
      sendResponse({ success: true });
    } else if (message.type === 'getState') {
      var ws = State.getWs();
      var isConnected = ws && ws.readyState === WebSocket.OPEN;
      
      chrome.storage.local.get(['wsAddress'], function(result) {
        var attachedTabs = State.getAttachedTabIds();
        var cdpClients = State.getCDPClients() || [];
        
        if (attachedTabs.length === 0) {
          sendResponse({
            connected: isConnected,
            serverAddress: result.wsAddress || Config.WS_URL,
            cdpClients: cdpClients,
            attachedPages: []
          });
          return;
        }
        
        var attachedPages = [];
        var pendingTabs = attachedTabs.length;
        
        attachedTabs.forEach(function(tabId) {
          chrome.tabs.get(tabId, function(tab) {
            pendingTabs--;
            
            if (chrome.runtime.lastError) {
              Logger.info('[Runtime] Tab not found:', tabId);
            } else if (tab) {
              attachedPages.push({
                tabId: tabId,
                title: tab.title || 'Untitled',
                url: tab.url || ''
              });
            }
            
            if (pendingTabs === 0) {
              sendResponse({
                connected: isConnected,
                serverAddress: result.wsAddress || Config.WS_URL,
                cdpClients: cdpClients,
                attachedPages: attachedPages
              });
            }
          });
        });
      });
      
      return true;
    } else if (message.type === 'connect') {
      var address = message.serverAddress;
      if (address) {
        Logger.info('[Runtime] Saving and connecting to:', address);
        chrome.storage.local.set({ wsAddress: address }, function() {
          var ws = State.getWs();
          if (ws) {
            ws.close();
          }
          WebSocketManager.connect();
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'No address provided' });
      }
      return true;
    } else if (message.type === 'disconnect') {
      Logger.info('[Runtime] Disconnecting...');
      var ws = State.getWs();
      if (ws) {
        ws.close();
      }
      sendResponse({ success: true });
    }
    return true;
  });

  init();
})();
