importScripts('utils/config.js');
importScripts('utils/logger.js');
importScripts('utils/helpers.js');
importScripts('utils/diagnostics.js');
importScripts('core/state.js');
importScripts('core/connection-state.js');
importScripts('core/connection-manager.js');
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
  var _initialized = false;

  function startKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }

    keepAliveInterval = setInterval(function() {
      ConnectionManager.forEachConnection(function(entry) {
        var ws = entry.state.getWs();
        if (ws && ws.readyState === WebSocket.OPEN) {
          entry.wsManager.send({ type: 'keepalive', timestamp: Date.now() });
        }
      });
    }, 20000);

    chrome.alarms.clear('sw-keepalive', function() {
      chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.4 });
    });
  }

  function stopKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
      Logger.info('[KeepAlive] Stopped keepalive interval');
    }
  }

  function init() {
    if (_initialized) {
      Logger.info('[Init] Already initialized, skipping');
      return;
    }
    _initialized = true;
    Logger.info('[Init] CDP Bridge starting...');

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

      Config.getConnections(function(connections) {
        ConnectionManager.init(connections);

        var primary = ConnectionManager.getPrimaryConnection();
        if (primary && result.currentTabId != null) {
          primary.state.currentTabId = result.currentTabId;
          primary.state.isAttached = result.isAttached;
        }

        ConnectionManager.connectAll();
        startKeepAlive();

        setTimeout(function() {
          Diagnostics.start();
        }, 2000);
      });
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

    var entry = ConnectionManager.getConnectionByTabId(tabId);
    var state = entry ? entry.state : null;
    var wsManager = entry ? entry.wsManager : null;

    if (state) {
      state.removeAttachedTab(tabId);
    }
    var removedClientId = state ? state.getClientIdByTabId(tabId) : null;
    Screencast.stopPolling(tabId, state);
    AutomationBadge.remove(tabId);

    if (state) {
      var sessionId = state.findSessionByTabId(tabId);
      if (sessionId) {
        var targetId = state.getTargetIdBySession(sessionId);
        EventBuilder.send('Target.detachedFromTarget', {
          sessionId: sessionId,
          targetId: targetId
        }, null, wsManager);
        EventBuilder.send('Target.targetDestroyed', { targetId: targetId }, null, wsManager);
        state.unmapSession(sessionId);
        if (removedClientId) {
          SpecialHandler.updateTabGroupName(removedClientId, state, wsManager);
        }
      }

      if (state.getCurrentTabId() === tabId) {
        state.persist(null, false);
      }
      state.removeTabIdToClientId(tabId);
    }
  });

  if (chrome.tabGroups) {
    chrome.tabGroups.onRemoved.addListener(function(group) {
      if (!group) return;
      var removedGroupId = group.id;
      Logger.info('[TabGroups] Group removed:', removedGroupId);

      ConnectionManager.forEachConnection(function(entry) {
        var state = entry.state;
        var wsManager = entry.wsManager;
        var clients = state.getCDPClients() || [];
        for (var i = 0; i < clients.length; i++) {
          var clientId = clients[i].id;
          if (state.getGroupIdForClient(clientId) === removedGroupId) {
            Logger.info('[TabGroups] Clearing cached groupId for client:', clientId);
            state.setGroupIdForClient(clientId, null);

            var attached = state.getAttachedTabIds();
            attached.forEach(function(tid) {
              if (state.getClientIdByTabId(tid) === clientId && !state.isPreExistingTab(tid)) {
                Logger.info('[TabGroups] Re-grouping tab', tid, 'for client:', clientId);
                var ctx = { _state: state, _wsManager: wsManager, clientId: clientId };
                SpecialHandler.addTabToAutomationGroup(tid, clientId, null, ctx);
              }
            });
            break;
          }
        }
      });
    });
  }

  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
      var entry = ConnectionManager.getConnectionByTabId(tabId);
      if (entry && entry.state.isTabAttached(tabId)) {
      }
    }

    if (changeInfo.groupId !== undefined && changeInfo.groupId === -1) {
      var entry = ConnectionManager.getConnectionByTabId(tabId);
      if (entry && entry.state.isTabAttached(tabId) && !entry.state.isPreExistingTab(tabId)) {
        var state = entry.state;
        var wsManager = entry.wsManager;
        var clientId = state.getClientIdByTabId(tabId);
        if (clientId) {
          var cachedGroupId = state.getGroupIdForClient(clientId);
          if (cachedGroupId) {
            Logger.info('[Tabs] Tab', tabId, 'left group, re-adding to cached group:', cachedGroupId);
            chrome.tabs.group({ tabIds: tabId, groupId: cachedGroupId }, function() {
              if (chrome.runtime.lastError) {
                Logger.warn('[Tabs] Failed to re-add tab to group:', chrome.runtime.lastError.message);
                var ctx = { _state: state, _wsManager: wsManager, clientId: clientId };
                SpecialHandler.addTabToAutomationGroup(tabId, clientId, null, ctx);
              }
            });
          } else {
            Logger.info('[Tabs] Tab', tabId, 'left group, no cached groupId — delegating to addTabToAutomationGroup');
            var ctx = { _state: state, _wsManager: wsManager, clientId: clientId };
            SpecialHandler.addTabToAutomationGroup(tabId, clientId, null, ctx);
          }
        }
      }
    }
  });

  chrome.tabs.onCreated.addListener(function(tab) {
    Logger.info('[Tabs] Tab created:', tab.id, tab.url, 'openerTabId:', tab.openerTabId);

    var entry = ConnectionManager.getPrimaryConnection();
    if (!entry) return;
    var state = entry.state;
    var wsManager = entry.wsManager;

    if (!state.hasConnectedClient()) {
      Logger.info('[Tabs] No connected client, skipping');
      return;
    }

    var tabId = tab.id;

    var tabUrl = tab.url || tab.pendingUrl || 'about:blank';
    if (state.hasPendingCreatedTabUrl(tabUrl)) {
      Logger.info('[Tabs] Tab created by Target.createTarget, will be handled by createTarget:', tabUrl);
      state.removePendingCreatedTabUrl(tabUrl);
      return;
    }

    var openerTabId = tab.openerTabId;
    var openerEntry = openerTabId ? ConnectionManager.getConnectionByTabId(openerTabId) : null;
    if (openerEntry) {
      state = openerEntry.state;
      wsManager = openerEntry.wsManager;
    }
    var isOpenerControlled = openerTabId && state.isTabAttached(openerTabId) && !state.isPreExistingTab(openerTabId);

    if (!openerTabId) {
      Logger.info('[Tabs] Tab has no opener, skipping. tabId:', tabId);
      return;
    }

    if (!isOpenerControlled) {
      Logger.info('[Tabs] Opener not controlled by CDP, skipping. tabId:', tabId, 'openerTabId:', openerTabId);
      return;
    }

    Logger.info('[Tabs] Tab has controlled opener, will attach. tabId:', tabId, 'openerTabId:', openerTabId);

    LocalHandler.getTargetInfoById(String(tabId)).then(function(targetInfo) {
      Logger.info('[Tabs] getTargetInfoById result:', targetInfo ? targetInfo.targetId : 'null');
      if (!targetInfo) {
        Logger.error('[Tabs] getTargetInfoById returned null for tabId:', tabId);
        return;
      }

      var targetId = targetInfo.targetId;
      Logger.info('[Tabs] targetId:', targetId);

      if (state.hasEmittedTarget(targetId)) {
        Logger.info('[Tabs] Target already emitted, skipping:', targetId);
        return;
      }

      state.addEmittedTarget(targetId);
      Logger.info('[Tabs] Sending Target.targetCreated event');

      EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo }, null, wsManager);
      Logger.info('[Tabs] Target.targetCreated sent, now attaching to tab:', tabId);

      return DebuggerManager.attach(tabId, state).then(function(attached) {
        Logger.info('[Tabs] DebuggerManager.attach result:', attached);
        if (!attached) {
          Logger.error('[Tabs] Failed to attach to tab:', tabId);
          return;
        }

        var sessionId = CDPUtils.generateSessionId();
        state.mapSession(sessionId, tabId, targetId);

        var openerClientId = openerTabId ? state.getClientIdByTabId(openerTabId) : null;
        if (openerClientId) {
          state.setTabIdToClientId(tabId, openerClientId);
          Logger.info('[Tabs] Mapped child tab', tabId, '-> clientId:', openerClientId);
        }

        Config.getAutoMute(function(enabled) {
          if (enabled) {
            chrome.tabs.update(tabId, { muted: true }, function() {
              if (chrome.runtime.lastError) {
                Logger.error('[TabMute] Failed to mute tab ' + tabId + ':', chrome.runtime.lastError.message);
              } else {
                Logger.info('[TabMute] Tab muted:', tabId);
              }
            });
          }
        });

        var ctx = { _state: state, _wsManager: wsManager, clientId: openerClientId };
        SpecialHandler.addTabToAutomationGroup(tabId, openerClientId, null, ctx);

        Logger.info('[Tabs] Sending Target.attachedToTarget event');

        EventBuilder.send('Target.attachedToTarget', {
          sessionId: sessionId,
          targetInfo: targetInfo,
          waitingForDebugger: false
        }, null, wsManager);
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
    setBadgeStatus('OFF');
    init();
  });

  chrome.runtime.onStartup.addListener(function() {
    Logger.info('[Runtime] Browser started');
    init();
  });

  function broadcastConnectionsUpdated() {
    chrome.runtime.sendMessage({ type: 'connections-updated' }).catch(function() {});
  }

  function _getAggregatedState() {
    var isConnected = false;
    var cdpClients = [];
    var attachedTabIds = [];
    ConnectionManager.forEachConnection(function(entry) {
      var ws = entry.state.getWs();
      if (ws && ws.readyState === WebSocket.OPEN) isConnected = true;
      cdpClients = cdpClients.concat(entry.state.getCDPClients() || []);
      attachedTabIds = attachedTabIds.concat(entry.state.getAttachedTabIds());
    });
    return { isConnected: isConnected, cdpClients: cdpClients, attachedTabIds: attachedTabIds };
  }

  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'popup-query') {
      var agg = _getAggregatedState();
      chrome.storage.local.get(['wsAddress', 'pluginId'], function(result) {
        sendResponse({
          connected: agg.isConnected,
          pluginId: result.pluginId || null,
          cdpClients: agg.cdpClients,
          attachedPages: agg.attachedTabIds.map(function(tid) { return { tabId: tid }; })
        });
      });
      return true;
    } else if (message.type === 'ws-reconnect') {
      Logger.info('[Runtime] WS address changed, reconnecting');
      ConnectionManager.disconnectAll();
      ConnectionManager.connectAll();
      sendResponse({ success: true });
    } else if (message.type === 'reconnect') {
      Logger.info('[Runtime] Received reconnect request from popup');
      ConnectionManager.disconnectAll();
      ConnectionManager.connectAll();
      sendResponse({ success: true });
    } else if (message.type === 'getState') {
      var agg = _getAggregatedState();
      chrome.storage.local.get(['wsAddress'], function(result) {
        var attachedTabs = agg.attachedTabIds;

        if (attachedTabs.length === 0) {
          sendResponse({
            connected: agg.isConnected,
            serverAddress: result.wsAddress || Config.WS_URL,
            cdpClients: agg.cdpClients,
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
                connected: agg.isConnected,
                serverAddress: result.wsAddress || Config.WS_URL,
                cdpClients: agg.cdpClients,
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
          ConnectionManager.disconnectAll();
          ConnectionManager.connectAll();
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'No address provided' });
      }
      return true;
    } else if (message.type === 'disconnect') {
      Logger.info('[Runtime] Disconnecting...');
      ConnectionManager.disconnectAll();
      sendResponse({ success: true });
    } else if (message.type === 'get-connection-statuses') {
      Config.getConnections(function(connections) {
        var list = (connections || []).map(function(conn) {
          var status = 'disabled';
          var attachedCount = 0;
          if (conn.enabled) {
            var entry = ConnectionManager.getConnection(conn.id);
            if (entry) {
              var ws = entry.state.getWs();
              status = (ws && ws.readyState === WebSocket.OPEN) ? 'connected' : 'error';
              attachedCount = entry.state.getAttachedTabIds().length;
            } else {
              status = 'error';
            }
          }
          return { id: conn.id, tag: conn.tag, url: conn.url, status: status, attachedCount: attachedCount };
        });
        sendResponse({ connections: list });
      });
      return true;
    } else if (message.type === 'add-connection') {
      Logger.info('[Runtime] Adding connection:', message.tag, message.url);
      Config.addConnection({ tag: message.tag, url: message.url }, function(conn) {
        if (conn && conn.enabled) {
          ConnectionManager.addConnection(conn);
          var entry = ConnectionManager.getConnection(conn.id);
          if (entry) entry.wsManager.connect();
        }
        broadcastConnectionsUpdated();
        sendResponse({ success: true });
      });
      return true;
    } else if (message.type === 'remove-connection') {
      Logger.info('[Runtime] Removing connection:', message.connectionId);
      ConnectionManager.removeConnection(message.connectionId);
      Config.removeConnection(message.connectionId, function() {
        broadcastConnectionsUpdated();
        sendResponse({ success: true });
      });
      return true;
    } else if (message.type === 'toggle-connection') {
      Logger.info('[Runtime] Toggling connection:', message.connectionId, message.enabled);
      Config.toggleConnection(message.connectionId, message.enabled, function() {
        if (message.enabled) {
          Config.getConnections(function(connections) {
            var conn = (connections || []).find(function(c) { return c.id === message.connectionId; });
            if (conn) {
              var wsMgr = ConnectionManager.addConnection(conn);
              if (wsMgr) wsMgr.connect();
            }
          });
        } else {
          ConnectionManager.removeConnection(message.connectionId);
        }
        broadcastConnectionsUpdated();
        sendResponse({ success: true });
      });
      return true;
    }
    return true;
  });

  chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name === 'sw-keepalive') {
      ConnectionManager.forEachConnection(function(entry) {
        var ws = entry.state.getWs();
        if (ws && ws.readyState === WebSocket.OPEN) {
          entry.wsManager.send({ type: 'keepalive', timestamp: Date.now() });
        } else {
          entry.wsManager.connect();
        }
      });
    }
  });

  init();
})();
