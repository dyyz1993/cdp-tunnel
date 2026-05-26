var WebSocketConnection = (function() {
  function WebSocketConnection(connectionId, state, config) {
    this.connectionId = connectionId;
    this.state = state;
    this.config = config;
    this._sendQueue = [];
    this._isSending = false;
    this._maxQueueSize = 100;
    this._bufferThreshold = 512 * 1024;
    this._groupCreationPending = new Set();
  }

  WebSocketConnection.prototype.connect = function() {
    var self = this;
    var ws = self.state.getWs();
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    var wsUrl = self.config.url;
    Config.getPluginId(function(pluginId) {
      if (pluginId) {
        var sep = wsUrl.indexOf('?') >= 0 ? '&' : '?';
        wsUrl += sep + 'pluginId=' + encodeURIComponent(pluginId);
      }
      Logger.info('[WS:' + self.connectionId + '] Connecting to', wsUrl);
      setBadgeStatus('ON');

      try {
        ws = new WebSocket(wsUrl);
        self.state.setWs(ws);

        ws.onopen = function() {
          Logger.info('[WS:' + self.connectionId + '] Connected');
          setBadgeStatus('ON');
          self.state.clearReconnectTimer();
          self._processQueue();
          self._broadcastStateUpdate();
          var extVersion = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
            ? chrome.runtime.getManifest().version : 'unknown';
          self.send({ type: 'plugin-hello', version: extVersion });
        };

        ws.onclose = function(event) {
          Logger.info('[WS:' + self.connectionId + '] Closed:', event.code, event.reason);
          setBadgeStatus('OFF');
          self._scheduleReconnect();
          self._broadcastStateUpdate();
        };

        ws.onerror = function(error) {
          Logger.error('[WS:' + self.connectionId + '] Error:', error);
          setBadgeStatus('ERR');
          self._broadcastStateUpdate();
        };

        ws.onmessage = function(event) {
          self._handleRawMessage(event.data);
        };
      } catch (error) {
        Logger.error('[WS:' + self.connectionId + '] Failed to create:', error);
        setBadgeStatus('ERR');
        self._scheduleReconnect();
      }
    });
  };

  WebSocketConnection.prototype.send = function(message) {
    var ws = this.state.getWs();
    var wsState = ws ? ws.readyState : 'no ws';
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      Logger.warn('[WS:' + this.connectionId + '] Cannot send, WebSocket not open. State:', wsState);
      return false;
    }

    var jsonStr;
    try {
      jsonStr = JSON.stringify(message);
    } catch (e) {
      Logger.error('[WS:' + this.connectionId + '] Failed to stringify message:', e);
      return false;
    }

    var msgSize = jsonStr.length;
    if (msgSize > 1024 * 1024) {
      Logger.warn('[WS:' + this.connectionId + '] Large message:', msgSize, 'bytes, method:', message.method || message.type);
    }

    if (ws.bufferedAmount > this._bufferThreshold) {
      Logger.warn('[WS:' + this.connectionId + '] Buffer full, queuing message. Buffered:', ws.bufferedAmount);
      if (this._sendQueue.length < this._maxQueueSize) {
        this._sendQueue.push(jsonStr);
      } else {
        Logger.error('[WS:' + this.connectionId + '] Queue full, dropping message');
      }
      return false;
    }

    try {
      ws.send(jsonStr);
      Logger.info('[WS:' + this.connectionId + '] SEND: ' + jsonStr.substring(0, 200));
      return true;
    } catch (e) {
      Logger.error('[WS:' + this.connectionId + '] Send error:', e);
      return false;
    }
  };

  WebSocketConnection.prototype._processQueue = function() {
    var ws = this.state.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    while (this._sendQueue.length > 0 && ws.bufferedAmount < this._bufferThreshold) {
      var data = this._sendQueue.shift();
      try {
        ws.send(data);
      } catch (e) {
        Logger.error('[WS:' + this.connectionId + '] Queue send error:', e);
        break;
      }
    }

    if (this._sendQueue.length > 0) {
      setTimeout(this._processQueue.bind(this), 100);
    }
  };

  WebSocketConnection.prototype._scheduleReconnect = function() {
    this.state.clearReconnectTimer();
    var self = this;
    var timer = setTimeout(function() {
      Logger.info('[WS:' + self.connectionId + '] Attempting to reconnect...');
      self.connect();
    }, Config.RECONNECT_DELAY);
    self.state.setReconnectTimer(timer);
  };

  WebSocketConnection.prototype._handleRawMessage = function(data) {
    var self = this;
    try {
      if (data instanceof Blob) {
        data.text().then(function(text) {
          try {
            self._handleMessage(JSON.parse(text));
          } catch (e) {
            Logger.error('[WS:' + self.connectionId + '] Failed to parse Blob message:', e);
          }
        }).catch(function(e) {
          Logger.error('[WS:' + self.connectionId + '] Failed to read Blob:', e);
        });
      } else {
        try {
          self._handleMessage(JSON.parse(data));
        } catch (e) {
          Logger.error('[WS:' + self.connectionId + '] Failed to parse message:', e);
        }
      }
    } catch (e) {
      Logger.error('[WS:' + self.connectionId + '] handleRawMessage error:', e);
    }
  };

  WebSocketConnection.prototype._handleMessage = function(message) {
    var self = this;
    var type = message.type;
    var method = message.method;
    var params = message.params;
    var id = message.id;
    var tabId = message.tabId;
    var sessionId = message.sessionId;

    switch (type) {
      case 'connected':
        if (message.fresh) {
          Logger.info('[WS:' + self.connectionId + '] Received fresh connection from server');
          self._handleServerRestart();
        }
        break;

      case 'ping':
        self.send({ type: 'pong' });
        break;

      case 'attach':
        var attachTabId = tabId || self.state.getCurrentTabId();
        DebuggerManager.attach(attachTabId, self.state).then(function(success) {
          self.send({ type: 'attach_result', tabId: attachTabId, success: success });
        });
        break;

      case 'detach':
        var detachTabId = tabId || self.state.getCurrentTabId();
        DebuggerManager.detach(detachTabId, self.state).then(function() {
          self.send({ type: 'detach_result', tabId: detachTabId, success: true });
        });
        break;

      case 'browser-close':
        self._handleBrowserClose(message.sessions, message.clientId);
        break;

      case 'client-connected':
        Logger.info('[WS:' + self.connectionId + '] Client connected, resuming event forwarding');
        self.state.setHasConnectedClient(true);
        self.state.addCDPClient(message.clientId, message.clientId);
        self._createGroupForClient(message.clientId);
        self._broadcastStateUpdate();
        break;

      case 'client-disconnected':
        Logger.info('[WS:' + self.connectionId + '] Client disconnected:', message.clientId);
        var discClientId = message.clientId;
        self._groupCreationPending.delete(discClientId);
        self._closeTabGroupByClientId(discClientId).then(function() {
          return new Promise(function(resolve) {
            self._closeTabsByClientId(discClientId, resolve);
          });
        }).then(function() {
          var preExistingTabs = self.state.getPreExistingTabs();
          var clientPreExisting = preExistingTabs.filter(function(tid) {
            return self.state.getClientIdByTabId(tid) === discClientId;
          });
          clientPreExisting.forEach(function(tid) {
            chrome.debugger.detach({ tabId: tid }).catch(function() {});
            self.state.removeAttachedTab(tid);
          });
          self.state.clearPreExistingTabsForClient(discClientId);
          self.state.removeCDPClient(discClientId);
          if (self.state.getCDPClients().length === 0) {
            self.state.setHasConnectedClient(false);
          }
          self._broadcastStateUpdate();
        });
        break;

      case 'client-list':
        Logger.info('[WS:' + self.connectionId + '] Received client list:', message.clients);
        self.state.setCDPClients(message.clients || []);
        self.state.setHasConnectedClient((message.clients || []).length > 0);
        self._broadcastStateUpdate();
        break;

      case 'plugin-disconnected':
        Logger.info('[WS:' + self.connectionId + '] Plugin disconnected from server');
        break;

      case 'server-restart':
        Logger.info('[WS:' + self.connectionId + '] Server restart detected, cleaning up...');
        self._handleServerRestart();
        break;

      case 'cdp':
        if (method) {
          routeCDPCommand({
            id: id,
            method: method,
            params: params,
            tabId: tabId,
            sessionId: sessionId,
            clientId: message.__clientId,
            connectionId: self.connectionId
          }, self.state, self);
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
            clientId: message.__clientId,
            connectionId: self.connectionId
          }, self.state, self);
        }
    }
  };

  WebSocketConnection.prototype._closeTabGroupByClientId = function(clientId) {
    var self = this;
    if (!clientId) return Promise.resolve();

    Logger.info('[WS:' + self.connectionId + '] Closing tab group for client:', clientId);

    return new Promise(function(resolve) {
      var timeoutId = setTimeout(function() {
        Logger.warn('[WS:' + self.connectionId + '] closeTabGroupByClientId timeout for client:', clientId, '— forcing cleanup');
        self._cleanupStaleState(clientId);
        resolve();
      }, 5000);

      var groupId = self.state.getGroupIdForClient(clientId);

      if (groupId) {
        self._closeGroupById(groupId, clientId, function() {
          clearTimeout(timeoutId);
          self._cleanupStaleState(clientId);
          resolve();
        });
      } else {
        var baseName = CDPUtils.getGroupBaseName(clientId, self.config ? self.config.tag : null);
        chrome.tabGroups.query({}, function(allGroups) {
          var match = CDPUtils.findGroupByName(allGroups, baseName);
          if (match) {
            self._closeGroupById(match.id, clientId, function() {
              clearTimeout(timeoutId);
              self._cleanupStaleState(clientId);
              resolve();
            });
          } else {
            Logger.info('[WS:' + self.connectionId + '] No tab group found, closing tabs by clientId:', clientId);
            self._closeTabsByClientId(clientId, function() {
              clearTimeout(timeoutId);
              self._cleanupStaleState(clientId);
              resolve();
            });
          }
        });
      }
    });
  };

  WebSocketConnection.prototype._cleanupStaleState = function(clientId) {
    if (!clientId) return;
    var self = this;
    var attachedTabs = self.state.getAttachedTabIds();
    attachedTabs.forEach(function(tabId) {
      if (self.state.getClientIdByTabId(tabId) === clientId) {
        self.state.removeTabIdToClientId(tabId);
      }
    });
  };

  WebSocketConnection.prototype._closeGroupById = function(groupId, clientId, resolve) {
    var self = this;
    Logger.info('[WS:' + self.connectionId + '] closeGroupById: groupId=' + groupId + ' clientId=' + clientId);
    chrome.tabs.query({ groupId: groupId }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        Logger.info('[WS:' + self.connectionId + '] No tabs in group:', groupId);
        self.state.removeGroupForClient(clientId);
        self._removeEmptyGroup(groupId);
        resolve();
        return;
      }

      var ownTabs = tabs.filter(function(tab) {
        return self.state.getClientIdByTabId(tab.id) === clientId;
      });
      var otherTabs = tabs.filter(function(tab) {
        return self.state.getClientIdByTabId(tab.id) !== clientId;
      });
      var tabIds = ownTabs.map(function(tab) { return tab.id; });
      Logger.info('[WS:' + self.connectionId + '] Closing ' + tabIds.length + ' tabs in group (skipping ' + otherTabs.length + ' from other clients):', groupId);

      if (tabIds.length === 0) {
        Logger.info('[WS:' + self.connectionId + '] No own tabs to close in group:', groupId);
        self.state.removeGroupForClient(clientId);
        resolve();
        return;
      }

      chrome.tabs.remove(tabIds, function() {
        if (chrome.runtime.lastError) {
          Logger.error('[WS:' + self.connectionId + '] Failed to close tabs:', chrome.runtime.lastError.message);
        } else {
          Logger.info('[WS:' + self.connectionId + '] Successfully closed ' + tabIds.length + ' tabs');
        }

        tabIds.forEach(function(tabId) {
          chrome.debugger.detach({ tabId: tabId }).catch(function() {});
        });

        self.state.removeGroupForClient(clientId);
        self._removeEmptyGroup(groupId);
        resolve();
      });
    });
  };

  WebSocketConnection.prototype._removeEmptyGroup = function(groupId) {
    if (!groupId || !chrome.tabGroups) return;
    setTimeout(function() {
      chrome.tabGroups.query({ groupId: groupId }, function(groups) {
        if (chrome.runtime.lastError) return;
        if (groups && groups.length > 0) {
          chrome.tabs.query({ groupId: groupId }, function(tabs) {
            if (chrome.runtime.lastError) return;
            if (!tabs || tabs.length === 0) {
              chrome.tabGroups.remove(groupId, function() {
                if (!chrome.runtime.lastError) {
                  Logger.info('[WS] Removed empty group:', groupId);
                }
              });
            }
          });
        }
      });
    }, 500);
  };

  WebSocketConnection.prototype._closeTabsByClientId = function(clientId, resolve) {
    var self = this;
    var attachedTabs = self.state.getAttachedTabIds();
    var cdpCreatedTabs = self.state.getCDPCreatedTabIds();
    var tabsToClose = [];
    var tabsToCloseSet = new Set();

    Logger.info('[WS:' + self.connectionId + '] closeTabsByClientId: clientId=' + clientId + ' attachedTabs=' + JSON.stringify(attachedTabs) + ' cdpCreatedTabs=' + JSON.stringify(cdpCreatedTabs));

    attachedTabs.forEach(function(tabId) {
      var tabClientId = self.state.getClientIdByTabId(tabId);
      var isPre = self.state.isPreExistingTab(tabId);
      var isCDP = self.state.isCDPCreatedTab(tabId);
      Logger.info('[WS:' + self.connectionId + ']   [attached] tabId=' + tabId + ' clientId=' + tabClientId + ' isPre=' + isPre + ' isCDP=' + isCDP);
      if (tabClientId === clientId && !isPre) {
        tabsToCloseSet.add(tabId);
      }
    });

    cdpCreatedTabs.forEach(function(tabId) {
      if (tabsToCloseSet.has(tabId)) return;

      var tabClientId = self.state.getClientIdByTabId(tabId);
      var isPre = self.state.isPreExistingTab(tabId);
      Logger.info('[WS:' + self.connectionId + ']   [cdpCreated] tabId=' + tabId + ' clientId=' + tabClientId + ' isPre=' + isPre + ' isAttached=' + attachedTabs.includes(tabId));
      if (tabClientId === clientId && !isPre && !attachedTabs.includes(tabId)) {
        tabsToCloseSet.add(tabId);
        Logger.info('[WS:' + self.connectionId + ']     -> Added to close list (not yet attached)');
      }
    });

    tabsToClose = Array.from(tabsToCloseSet);
    Logger.info('[WS:' + self.connectionId + '] closeTabsByClientId: will close ' + tabsToClose.length + ' tabs');

    if (tabsToClose.length === 0) {
      Logger.info('[WS:' + self.connectionId + '] No tabs found for clientId:', clientId);
      resolve();
      return;
    }

    self._doCloseTabs(tabsToClose, clientId, resolve);
  };

  WebSocketConnection.prototype._doCloseTabs = function(tabIds, clientId, resolve) {
    var self = this;
    if (tabIds.length === 0) {
      resolve();
      return;
    }
    Logger.info('[WS:' + self.connectionId + '] Closing ' + tabIds.length + ' attached tabs for clientId:', clientId);
    var pending = tabIds.length;
    tabIds.forEach(function(tabId) {
      chrome.tabs.remove(tabId, function() {
        if (chrome.runtime.lastError) {
          Logger.info('[WS:' + self.connectionId + '] Tab already closed:', tabId);
        }
        chrome.debugger.detach({ tabId: tabId }).catch(function() {});
        self.state.removeAttachedTab(tabId);
        pending--;
        if (pending === 0) resolve();
      });
    });
  };

  WebSocketConnection.prototype._createGroupForClient = function(clientId) {
    var self = this;
    if (!clientId || !chrome.tabGroups) return;

    if (self._groupCreationPending.has(clientId)) {
      Logger.info('[WS:' + self.connectionId + '] Group creation already pending for client:', clientId);
      return;
    }

    var existingGroupId = self.state.getGroupIdForClient(clientId);
    if (existingGroupId) {
      Logger.info('[WS:' + self.connectionId + '] Group already cached for client:', clientId, 'groupId:', existingGroupId);
      return;
    }

    self._groupCreationPending.add(clientId);

    var baseName = CDPUtils.getGroupBaseName(clientId, self.config ? self.config.tag : null);
    chrome.tabs.query({ currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        Logger.warn('[WS:' + self.connectionId + '] No tabs found for group creation');
        self._groupCreationPending.delete(clientId);
        return;
      }
      var windowId = tabs[0].windowId;
      chrome.tabs.group({ createProperties: { windowId: windowId } }, function(groupId) {
        if (chrome.runtime.lastError) {
          Logger.warn('[WS:' + self.connectionId + '] Failed to create group on connect:', chrome.runtime.lastError.message);
          self._groupCreationPending.delete(clientId);
          return;
        }
        self._groupCreationPending.delete(clientId);
        chrome.tabGroups.update(groupId, {
          title: baseName,
          color: CDPUtils.getGroupColorForClient(clientId),
          collapsed: true
        }, function() {
          if (chrome.runtime.lastError) {
            Logger.warn('[WS:' + self.connectionId + '] Failed to set group title:', chrome.runtime.lastError.message);
          }
        });
        self.state.setGroupIdForClient(clientId, groupId);
        Logger.info('[WS:' + self.connectionId + '] Created group for client:', clientId, 'groupId:', groupId, 'title:', baseName);
      });
    });
  };

  WebSocketConnection.prototype._handleServerRestart = function() {
    var self = this;
    Logger.info('[WS:' + self.connectionId + '] Server restarted, cleaning up all state...');

    var attachedTabIds = self.state.getAttachedTabIds();
    var promises = attachedTabIds.map(function(tabId) {
      return chrome.debugger.detach({ tabId: tabId }).catch(function(e) {
        Logger.info('[WS:' + self.connectionId + '] Detach failed for tab', tabId, ':', e.message);
      });
    });

    Promise.all(promises).then(function() {
      self.state.clearAllState();
      self.state.persist(null, false);
      Logger.info('[WS:' + self.connectionId + '] State cleaned up after server restart');
    });
  };

  WebSocketConnection.prototype._handleBrowserClose = function(sessions, clientId) {
    var self = this;
    Logger.info('[WS:' + self.connectionId + '] Browser.close received, cleaning up... clientId:', clientId);

    self._closeTabGroupByClientId(clientId).then(function() {
      return new Promise(function(resolve) {
        self._closeTabsByClientId(clientId, resolve);
      });
    }).then(function() {
      var preExistingTabs = self.state.getPreExistingTabs();
      var clientPreExisting = preExistingTabs.filter(function(tabId) {
        return self.state.getClientIdByTabId(tabId) === clientId;
      });
      clientPreExisting.forEach(function(tabId) {
        chrome.debugger.detach({ tabId: tabId }).catch(function() {});
        self.state.removeAttachedTab(tabId);
      });
      self.state.clearPreExistingTabsForClient(clientId);

      self.state.removeCDPClient(clientId);
      if (self.state.getCDPClients().length === 0) {
        self.state.clearAllState();
        self.state.persist(null, false);
      }
      self._broadcastStateUpdate();
      Logger.info('[WS:' + self.connectionId + '] Browser.close cleanup complete for client:', clientId);
    });
  };

  WebSocketConnection.prototype._broadcastStateUpdate = function() {
    var self = this;
    var ws = self.state.getWs();
    var isConnected = ws && ws.readyState === WebSocket.OPEN;
    var cdpClients = self.state.getCDPClients() || [];
    var attachedTabIds = self.state.getAttachedTabIds();

    if (attachedTabIds.length === 0) {
      chrome.runtime.sendMessage({
        type: 'stateUpdate',
        connected: isConnected,
        cdpClients: cdpClients,
        attachedPages: []
      }).catch(function() {});
      return;
    }

    var attachedPages = [];
    var pending = attachedTabIds.length;
    attachedTabIds.forEach(function(tabId) {
      chrome.tabs.get(tabId, function(tab) {
        if (tab && !chrome.runtime.lastError) {
          attachedPages.push({
            tabId: tabId,
            title: tab.title || 'Untitled',
            url: tab.url || ''
          });
        }
        pending--;
        if (pending === 0) {
          chrome.runtime.sendMessage({
            type: 'stateUpdate',
            connected: isConnected,
            cdpClients: cdpClients,
            attachedPages: attachedPages
          }).catch(function() {});
        }
      });
    });
  };

  WebSocketConnection.prototype.getQueueStats = function() {
    return {
      queueLength: this._sendQueue.length,
      maxQueueSize: this._maxQueueSize,
      bufferThreshold: this._bufferThreshold
    };
  };

  return WebSocketConnection;
})();

function setBadgeStatus(status) {
  var colors = Config.BADGE_COLORS;
  chrome.action.setBadgeText({ text: status });
  chrome.action.setBadgeBackgroundColor({ color: colors[status] || colors.OFF });
}

var WebSocketManager = (function() {
  function connect() {
    ConnectionManager.connectAll();
  }

  function send(message) {
    var sent = false;
    ConnectionManager.forEachConnection(function(entry) {
      if (entry.wsManager.send(message)) {
        sent = true;
      }
    });
    return sent;
  }

  function scheduleReconnect() {
    ConnectionManager.forEachConnection(function(entry) {
      entry.wsManager._scheduleReconnect();
    });
  }

  function getQueueStats() {
    var stats = [];
    ConnectionManager.forEachConnection(function(entry) {
      stats.push({
        connectionId: entry.id,
        stats: entry.wsManager.getQueueStats()
      });
    });
    return stats;
  }

  function processQueue() {
    ConnectionManager.forEachConnection(function(entry) {
      entry.wsManager._processQueue();
    });
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
