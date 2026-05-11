var WebSocketManager = (function() {
  var _sendQueue = [];
  var _isSending = false;
  var _maxQueueSize = 100;
  var _bufferThreshold = 512 * 1024;

  function connect() {
    var ws = State.getWs();
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    Config.getWsUrl(function(wsUrl) {
      Logger.info('[WS] Connecting to', wsUrl);
      setBadgeStatus('ON');

      try {
        ws = new WebSocket(wsUrl);
        State.setWs(ws);

        ws.onopen = function() {
          Logger.info('[WS] Connected');
          setBadgeStatus('ON');
          State.clearReconnectTimer();
          processQueue();
          broadcastStateUpdate();
        };

        ws.onclose = function(event) {
          Logger.info('[WS] Closed:', event.code, event.reason);
          setBadgeStatus('OFF');
          scheduleReconnect();
          broadcastStateUpdate();
        };

        ws.onerror = function(error) {
          Logger.error('[WS] Error:', error);
          setBadgeStatus('ERR');
          broadcastStateUpdate();
        };

        ws.onmessage = function(event) {
          handleRawMessage(event.data);
        };
      } catch (error) {
        Logger.error('[WS] Failed to create:', error);
        setBadgeStatus('ERR');
        scheduleReconnect();
      }
    });
  }

  function send(message) {
    var ws = State.getWs();
    var wsState = ws ? ws.readyState : 'no ws';
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      Logger.warn('[WS] Cannot send, WebSocket not open. State:', wsState);
      return false;
    }

    var jsonStr;
    try {
      jsonStr = JSON.stringify(message);
    } catch (e) {
      Logger.error('[WS] Failed to stringify message:', e);
      return false;
    }

    var msgSize = jsonStr.length;
    
    if (msgSize > 1024 * 1024) {
      Logger.warn('[WS] Large message:', msgSize, 'bytes, method:', message.method || message.type);
    }

    if (ws.bufferedAmount > _bufferThreshold) {
      Logger.warn('[WS] Buffer full, queuing message. Buffered:', ws.bufferedAmount);
      if (_sendQueue.length < _maxQueueSize) {
        _sendQueue.push(jsonStr);
      } else {
        Logger.error('[WS] Queue full, dropping message');
      }
      return false;
    }

    try {
      ws.send(jsonStr);
      Logger.info('[WS] SEND: ' + jsonStr.substring(0, 200));
      return true;
    } catch (e) {
      Logger.error('[WS] Send error:', e);
      return false;
    }
  }

  function processQueue() {
    var ws = State.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    while (_sendQueue.length > 0 && ws.bufferedAmount < _bufferThreshold) {
      var data = _sendQueue.shift();
      try {
        ws.send(data);
      } catch (e) {
        Logger.error('[WS] Queue send error:', e);
        break;
      }
    }

    if (_sendQueue.length > 0) {
      setTimeout(processQueue, 100);
    }
  }

  function scheduleReconnect() {
    State.clearReconnectTimer();
    var timer = setTimeout(function() {
      Logger.info('[WS] Attempting to reconnect...');
      connect();
    }, Config.RECONNECT_DELAY);
    State.setReconnectTimer(timer);
  }

  function handleRawMessage(data) {
    try {
      if (data instanceof Blob) {
        data.text().then(function(text) {
          try {
            handleMessage(JSON.parse(text));
          } catch (e) {
            Logger.error('[WS] Failed to parse Blob message:', e);
          }
        }).catch(function(e) {
          Logger.error('[WS] Failed to read Blob:', e);
        });
      } else {
        try {
          handleMessage(JSON.parse(data));
        } catch (e) {
          Logger.error('[WS] Failed to parse message:', e);
        }
      }
    } catch (e) {
      Logger.error('[WS] handleRawMessage error:', e);
    }
  }

  function handleMessage(message) {
    var type = message.type;
    var method = message.method;
    var params = message.params;
    var id = message.id;
    var tabId = message.tabId;
    var sessionId = message.sessionId;

    switch (type) {
      case 'connected':
        if (message.fresh) {
          Logger.info('[WS] Received fresh connection from server');
          handleServerRestart();
        }
        break;

      case 'ping':
        send({ type: 'pong' });
        break;

      case 'attach':
        var attachTabId = tabId || State.getCurrentTabId();
        DebuggerManager.attach(attachTabId).then(function(success) {
          send({ type: 'attach_result', tabId: attachTabId, success: success });
        });
        break;

      case 'detach':
        var detachTabId = tabId || State.getCurrentTabId();
        DebuggerManager.detach(detachTabId).then(function() {
          send({ type: 'detach_result', tabId: detachTabId, success: true });
        });
        break;

      case 'browser-close':
        handleBrowserClose(message.sessions, message.clientId);
        break;

      case 'client-connected':
        Logger.info('[WS] Client connected, resuming event forwarding');
        State.setHasConnectedClient(true);
        State.addCDPClient(message.clientId, message.clientId);
        broadcastStateUpdate();
        break;

      case 'client-disconnected':
        Logger.info('[WS] Client disconnected:', message.clientId);
        var discClientId = message.clientId;
        closeTabGroupByClientId(discClientId).then(function() {
          return new Promise(function(resolve) {
            closeTabsByClientId(discClientId, resolve);
          });
        }).then(function() {
          var preExistingTabs = State.getPreExistingTabs();
          var clientPreExisting = preExistingTabs.filter(function(tabId) {
            return State.getClientIdByTabId(tabId) === discClientId;
          });
          clientPreExisting.forEach(function(tabId) {
            chrome.debugger.detach({ tabId: tabId }).catch(function() {});
            State.removeAttachedTab(tabId);
          });
          State.clearPreExistingTabsForClient(discClientId);

          State.removeCDPClient(discClientId);
          if (State.getCDPClients().length === 0) {
            State.setHasConnectedClient(false);
          }
          broadcastStateUpdate();
        });
        break;
        
      case 'client-list':
        Logger.info('[WS] Received client list:', message.clients);
        State.setCDPClients(message.clients || []);
        State.setHasConnectedClient((message.clients || []).length > 0);
        broadcastStateUpdate();
        break;

      case 'plugin-disconnected':
        Logger.info('[WS] Plugin disconnected from server');
        break;

      case 'server-restart':
        Logger.info('[WS] Server restart detected, cleaning up...');
        handleServerRestart();
        break;

      case 'cdp':
        if (method) {
          routeCDPCommand({
            id: id,
            method: method,
            params: params,
            tabId: tabId,
            sessionId: sessionId,
            clientId: message.__clientId
          });
        }
        break;

      default:
        if (method) {
          routeCDPCommand({
            id: id,
            method: method,
            params: params,
            tabId: tabId,
            sessionId: sessionId,
            clientId: message.__clientId
          });
        }
    }
  }

  function closeTabGroupByClientId(clientId) {
    if (!clientId) return Promise.resolve();
    
    Logger.info('[WS] Closing tab group for client:', clientId);
    
    return new Promise(function(resolve) {
        var groupId = State.getGroupIdForClient(clientId);
        
        if (groupId) {
            closeGroupById(groupId, clientId, resolve);
        } else {
            var baseName = CDPUtils.getGroupBaseName(clientId);
            chrome.tabGroups.query({}, function(allGroups) {
                var match = CDPUtils.findGroupByName(allGroups, baseName);
                if (match) {
                    closeGroupById(match.id, clientId, resolve);
                } else {
                    Logger.info('[WS] No tab group found, closing tabs by clientId:', clientId);
                    closeTabsByClientId(clientId, resolve);
                }
            });
        }
    });
  }

  function closeGroupById(groupId, clientId, resolve) {
    chrome.tabs.query({ groupId: groupId }, function(tabs) {
        if (!tabs || tabs.length === 0) {
            Logger.info('[WS] No tabs in group:', groupId);
            State.removeGroupForClient(clientId);
            resolve();
            return;
        }
        
        var tabIds = tabs.map(function(tab) { return tab.id; });
        Logger.info('[WS] Closing ' + tabIds.length + ' tabs in group:', groupId);
        
        chrome.tabs.remove(tabIds, function() {
            if (chrome.runtime.lastError) {
                Logger.error('[WS] Failed to close tabs:', chrome.runtime.lastError.message);
            } else {
                Logger.info('[WS] Successfully closed ' + tabIds.length + ' tabs');
            }
            
            tabIds.forEach(function(tabId) {
                chrome.debugger.detach({ tabId: tabId }).catch(function() {});
            });
            
            State.removeGroupForClient(clientId);
            resolve();
        });
    });
  }

  function closeTabsByClientId(clientId, resolve) {
    var attachedTabs = State.getAttachedTabIds();
    var tabsToClose = [];
    
    attachedTabs.forEach(function(tabId) {
      if (State.getClientIdByTabId(tabId) === clientId && !State.isPreExistingTab(tabId)) {
        tabsToClose.push(tabId);
      }
    });
    
    if (tabsToClose.length === 0) {
      Logger.info('[WS] No attached tabs found for clientId:', clientId);
      resolve();
      return;
    }

    doCloseTabs(tabsToClose, clientId, resolve);
  }

  function doCloseTabs(tabIds, clientId, resolve) {
    if (tabIds.length === 0) {
      resolve();
      return;
    }
    Logger.info('[WS] Closing ' + tabIds.length + ' attached tabs for clientId:', clientId);
    tabIds.forEach(function(tabId) {
      chrome.tabs.remove(tabId, function() {
        if (chrome.runtime.lastError) {
          Logger.info('[WS] Tab already closed:', tabId);
        }
      });
      chrome.debugger.detach({ tabId: tabId }).catch(function() {});
      State.removeAttachedTab(tabId);
    });
    resolve();
  }

  function handleServerRestart() {
    Logger.info('[WS] Server restarted, cleaning up all state...');

    var attachedTabIds = State.getAttachedTabIds();
    var promises = attachedTabIds.map(function(tabId) {
      return chrome.debugger.detach({ tabId: tabId }).catch(function(e) {
        Logger.info('[WS] Detach failed for tab', tabId, ':', e.message);
      });
    });

    Promise.all(promises).then(function() {
      State.clearAllState();
      State.persist(null, false);
      Logger.info('[WS] State cleaned up after server restart');
    });
  }

  function handleBrowserClose(sessions, clientId) {
    Logger.info('[WS] Browser.close received, cleaning up... clientId:', clientId);
    
    closeTabGroupByClientId(clientId).then(function() {
      var attachedTabIds = State.getAttachedTabIds();
      var promises = attachedTabIds.map(function(tabId) {
          return chrome.debugger.detach({ tabId: tabId }).catch(function(e) {
            Logger.info('[WS] Detach failed for tab', tabId, ':', e.message);
          });
      });
      Promise.all(promises).then(function() {
        State.clearAllState();
        State.persist(null, false);
        Logger.info('[WS] Browser.close cleanup complete');
      });
    });
  }

  function setBadgeStatus(status) {
    var colors = Config.BADGE_COLORS;
    chrome.action.setBadgeText({ text: status });
    chrome.action.setBadgeBackgroundColor({ color: colors[status] || colors.OFF });
  }

  function broadcastStateUpdate() {
    var ws = State.getWs();
    var isConnected = ws && ws.readyState === WebSocket.OPEN;
    var cdpClients = State.getCDPClients() || [];
    var attachedTabIds = State.getAttachedTabIds();
    
    var attachedPages = [];
    attachedTabIds.forEach(function(tabId) {
      chrome.tabs.get(tabId, function(tab) {
        if (tab && !chrome.runtime.lastError) {
          attachedPages.push({
            tabId: tabId,
            title: tab.title || 'Untitled',
            url: tab.url || ''
          });
        }
      });
    });
    
    chrome.runtime.sendMessage({
      type: 'stateUpdate',
      connected: isConnected,
      cdpClients: cdpClients,
      attachedPages: attachedPages
    }).catch(function() {});
  }

  function getQueueStats() {
    return {
      queueLength: _sendQueue.length,
      maxQueueSize: _maxQueueSize,
      bufferThreshold: _bufferThreshold
    };
  }

  return {
    connect: connect,
    send: send,
    scheduleReconnect: scheduleReconnect,
    setBadgeStatus: setBadgeStatus,
    getQueueStats: getQueueStats,
    processQueue: processQueue
  };
})();
