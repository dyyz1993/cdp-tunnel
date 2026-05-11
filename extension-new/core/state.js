var State = (function() {
  var _state = {
    ws: null,
    reconnectTimer: null,
    hasConnectedClient: false,
    cdpClients: [],
    sessionIdToTabId: new Map(),
    sessionIdToTargetId: new Map(),
    attachedTabIds: new Set(),
    emittedTargets: new Set(),
    browserContextIds: new Set(['default']),
    autoAttachConfig: { 
      autoAttach: false, 
      waitForDebuggerOnStart: false, 
      flatten: true 
    },
    discoverTargetsEnabled: false,
    pendingDebuggerTabs: new Set(),
    screencastPollingSessions: new Map(),
    automatedTabs: new Set(),
    currentTabId: null,
    isAttached: false,
    pendingCreatedTabUrls: new Set(),
    clientIdToTabId: new Map(),
    clientIdToSessionId: new Map(),
    tabIdToClientId: new Map(),
    clientIdToGroupId: new Map(),
    preExistingTabIds: new Set()
  };

  function mapSession(sessionId, tabId, targetId) {
    _state.sessionIdToTabId.set(sessionId, tabId);
    _state.sessionIdToTargetId.set(sessionId, targetId);
    _state.attachedTabIds.add(tabId);
  }

  function unmapSession(sessionId) {
    var tabId = _state.sessionIdToTabId.get(sessionId);
    _state.sessionIdToTabId.delete(sessionId);
    _state.sessionIdToTargetId.delete(sessionId);
    if (tabId && !hasOtherSessionForTab(tabId)) {
      _state.attachedTabIds.delete(tabId);
    }
    return tabId;
  }

  function getTabIdBySession(sessionId) {
    return _state.sessionIdToTabId.get(sessionId);
  }

  function getTargetIdBySession(sessionId) {
    return _state.sessionIdToTargetId.get(sessionId);
  }

  function findSessionByTabId(tabId) {
    var entries = _state.sessionIdToTabId.entries();
    var entry = entries.next();
    while (!entry.done) {
      if (entry.value[1] === tabId) {
        return entry.value[0];
      }
      entry = entries.next();
    }
    return null;
  }

  function findSessionByTargetId(targetId) {
    var entries = _state.sessionIdToTargetId.entries();
    var entry = entries.next();
    while (!entry.done) {
      if (entry.value[1] === targetId) {
        return entry.value[0];
      }
      entry = entries.next();
    }
    return null;
  }

  function getTabIdByTargetId(targetId) {
    var sessionId = findSessionByTargetId(targetId);
    if (sessionId) {
      return _state.sessionIdToTabId.get(sessionId);
    }
    return null;
  }

  function hasOtherSessionForTab(tabId) {
    var count = 0;
    _state.sessionIdToTabId.forEach(function(mappedTabId) {
      if (mappedTabId === tabId) {
        count++;
      }
    });
    return count > 0;
  }

  function addAttachedTab(tabId) {
    _state.attachedTabIds.add(tabId);
  }

  function removeAttachedTab(tabId) {
    _state.attachedTabIds.delete(tabId);
  }

  function isTabAttached(tabId) {
    return _state.attachedTabIds.has(tabId);
  }

  function getAttachedTabIds() {
    return Array.from(_state.attachedTabIds);
  }

  function addEmittedTarget(targetId) {
    _state.emittedTargets.add(targetId);
  }

  function hasEmittedTarget(targetId) {
    return _state.emittedTargets.has(targetId);
  }

  function setAutoAttachConfig(config) {
    Object.assign(_state.autoAttachConfig, config);
  }

  function getAutoAttachConfig() {
    return Object.assign({}, _state.autoAttachConfig);
  }

  function setDiscoverTargets(enabled) {
    _state.discoverTargetsEnabled = enabled;
  }

  function addPendingDebuggerTab(tabId) {
    _state.pendingDebuggerTabs.add(tabId);
  }

  function removePendingDebuggerTab(tabId) {
    _state.pendingDebuggerTabs.delete(tabId);
  }

  function isPendingDebuggerTab(tabId) {
    return _state.pendingDebuggerTabs.has(tabId);
  }

  function addBrowserContext(id) {
    _state.browserContextIds.add(id);
  }

  function removeBrowserContext(id) {
    _state.browserContextIds.delete(id);
  }

  function getBrowserContexts() {
    return Array.from(_state.browserContextIds);
  }

  function loadPersisted() {
    return new Promise(function(resolve) {
      chrome.storage.local.get(['currentTabId', 'isAttached'], function(result) {
        _state.currentTabId = result.currentTabId || null;
        _state.isAttached = result.isAttached || false;
        resolve(result);
      });
    });
  }

  function persist(tabId, attached) {
    _state.currentTabId = tabId;
    _state.isAttached = attached;
    return new Promise(function(resolve) {
      chrome.storage.local.set({ currentTabId: tabId, isAttached: attached }, resolve);
    });
  }

  function getCurrentTabId() {
    return _state.currentTabId;
  }

  function setCurrentTabId(tabId) {
    _state.currentTabId = tabId;
  }

  function getWs() {
    return _state.ws;
  }

  function setWs(ws) {
    _state.ws = ws;
  }

  function getReconnectTimer() {
    return _state.reconnectTimer;
  }

  function setReconnectTimer(timer) {
    _state.reconnectTimer = timer;
  }

  function clearReconnectTimer() {
    if (_state.reconnectTimer) {
      clearTimeout(_state.reconnectTimer);
      _state.reconnectTimer = null;
    }
  }

  function hasConnectedClient() {
    return _state.hasConnectedClient;
  }

  function setHasConnectedClient(value) {
    _state.hasConnectedClient = value;
  }

  function addPendingCreatedTabUrl(url) {
    _state.pendingCreatedTabUrls.add(url);
  }

  function removePendingCreatedTabUrl(url) {
    _state.pendingCreatedTabUrls.delete(url);
  }

  function hasPendingCreatedTabUrl(url) {
    return _state.pendingCreatedTabUrls.has(url);
  }

  function getScreencastSession(tabId) {
    return _state.screencastPollingSessions.get(tabId);
  }

  function setScreencastSession(tabId, session) {
    _state.screencastPollingSessions.set(tabId, session);
  }

  function deleteScreencastSession(tabId) {
    _state.screencastPollingSessions.delete(tabId);
  }

  function addAutomatedTab(tabId) {
    _state.automatedTabs.add(tabId);
  }

  function removeAutomatedTab(tabId) {
    _state.automatedTabs.delete(tabId);
  }

  function getAutomatedTabs() {
    return Array.from(_state.automatedTabs);
  }

  function clearSessionState() {
    _state.sessionIdToTabId.clear();
    _state.sessionIdToTargetId.clear();
    _state.pendingDebuggerTabs.clear();
    _state.emittedTargets.clear();
  }

  function clearAllState() {
    clearSessionState();
    _state.attachedTabIds.clear();
    _state.emittedTargets.clear();
    _state.screencastPollingSessions.clear();
    _state.browserContextIds = new Set(['default']);
    _state.autoAttachConfig = { 
      autoAttach: false, 
      waitForDebuggerOnStart: false, 
      flatten: true 
    };
    _state.discoverTargetsEnabled = false;
    _state.hasConnectedClient = false;
    _state.tabIdToClientId.clear();
    _state.clientIdToGroupId.clear();
    _state.clientIdToTabId.clear();
    _state.clientIdToSessionId.clear();
    _state.preExistingTabIds.clear();
    _state.pendingDebuggerTabs.clear();
    _state.automatedTabs.clear();
    _state.pendingCreatedTabUrls.clear();
    _state.cdpClients = [];
  }

  function cleanupAllTabs() {
    return new Promise(function(resolve) {
      var tabIds = Array.from(_state.attachedTabIds);
      
      var detachPromises = tabIds.map(function(tabId) {
        return chrome.debugger.detach({ tabId: tabId }).catch(function() {});
      });
      
      Promise.all(detachPromises).then(function() {
        chrome.tabGroups.query({}, function(groups) {
          if (!groups || groups.length === 0) {
            clearAllState();
            persist(null, false).then(resolve);
            return;
          }
          
          var cdpGroups = groups.filter(function(g) {
            return g.title && (g.title.indexOf('CDP-') === 0 || g.title.indexOf('CDP #') === 0);
          });
          
          if (cdpGroups.length === 0) {
            clearAllState();
            persist(null, false).then(resolve);
            return;
          }
          
          var closePromises = cdpGroups.map(function(group) {
            return new Promise(function(res) {
              chrome.tabs.query({ groupId: group.id }, function(tabs) {
                if (!tabs || tabs.length === 0) {
                  res();
                  return;
                }
                var ids = tabs.map(function(t) { return t.id; });
                chrome.tabs.remove(ids, function() {
                  if (chrome.runtime.lastError) {
                    console.error('[State] Failed to close tabs:', chrome.runtime.lastError.message);
                  }
                  res();
                });
              });
            });
          });
          
          Promise.all(closePromises).then(function() {
            clearAllState();
            persist(null, false).then(resolve);
          });
        });
      });
    });
  }

  function mapClientIdToTab(clientId, tabId, sessionId) {
    _state.clientIdToTabId.set(clientId, tabId);
    if (sessionId) {
      _state.clientIdToSessionId.set(clientId, sessionId);
    }
  }

  function setTabIdToClientId(tabId, clientId) {
    _state.tabIdToClientId.set(tabId, clientId);
  }

  function removeTabIdToClientId(tabId) {
    _state.tabIdToClientId.delete(tabId);
  }

  function getClientIdByTabId(tabId) {
    return _state.tabIdToClientId.get(tabId);
  }

  function setGroupIdForClient(clientId, groupId) {
    _state.clientIdToGroupId.set(clientId, groupId);
  }

  function getGroupIdForClient(clientId) {
    return _state.clientIdToGroupId.get(clientId);
  }

  function removeGroupForClient(clientId) {
    _state.clientIdToGroupId.delete(clientId);
  }

  function addPreExistingTab(tabId) {
    _state.preExistingTabIds.add(tabId);
  }

  function isPreExistingTab(tabId) {
    return _state.preExistingTabIds.has(tabId);
  }

  function getPreExistingTabs() {
    return Array.from(_state.preExistingTabIds);
  }

  function removePreExistingTab(tabId) {
    _state.preExistingTabIds.delete(tabId);
  }

  function clearPreExistingTabsForClient(clientId) {
    _state.preExistingTabIds.forEach(function(tabId) {
      if (State.getClientIdByTabId(tabId) === clientId) {
        _state.preExistingTabIds.delete(tabId);
      }
    });
  }

  function getTabIdByClientId(clientId) {
    return _state.clientIdToTabId.get(clientId);
  }

  function getSessionIdByClientId(clientId) {
    return _state.clientIdToSessionId.get(clientId);
  }

  function unmapClientId(clientId) {
    _state.clientIdToTabId.delete(clientId);
    _state.clientIdToSessionId.delete(clientId);
  }
  
  function addCDPClient(clientId, info) {
    var exists = false;
    for (var i = 0; i < _state.cdpClients.length; i++) {
      if (_state.cdpClients[i].id === clientId) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      _state.cdpClients.push({
        id: clientId,
        connectedAt: Date.now()
      });
    }
  }
  
  function removeCDPClient(clientId) {
    var newClients = [];
    for (var i = 0; i < _state.cdpClients.length; i++) {
      if (_state.cdpClients[i].id !== clientId) {
        newClients.push(_state.cdpClients[i]);
      }
    }
    _state.cdpClients = newClients;
  }
  
  function getCDPClients() {
    return _state.cdpClients;
  }
  
  function setCDPClients(clients) {
    _state.cdpClients = clients || [];
  }

  return {
    mapSession: mapSession,
    unmapSession: unmapSession,
    getTabIdBySession: getTabIdBySession,
    getTargetIdBySession: getTargetIdBySession,
    findSessionByTabId: findSessionByTabId,
    findSessionByTargetId: findSessionByTargetId,
    getTabIdByTargetId: getTabIdByTargetId,
    hasOtherSessionForTab: hasOtherSessionForTab,
    addAttachedTab: addAttachedTab,
    removeAttachedTab: removeAttachedTab,
    isTabAttached: isTabAttached,
    getAttachedTabIds: getAttachedTabIds,
    addEmittedTarget: addEmittedTarget,
    hasEmittedTarget: hasEmittedTarget,
    setAutoAttachConfig: setAutoAttachConfig,
    getAutoAttachConfig: getAutoAttachConfig,
    setDiscoverTargets: setDiscoverTargets,
    addPendingDebuggerTab: addPendingDebuggerTab,
    removePendingDebuggerTab: removePendingDebuggerTab,
    isPendingDebuggerTab: isPendingDebuggerTab,
    addBrowserContext: addBrowserContext,
    removeBrowserContext: removeBrowserContext,
    getBrowserContexts: getBrowserContexts,
    loadPersisted: loadPersisted,
    persist: persist,
    getCurrentTabId: getCurrentTabId,
    setCurrentTabId: setCurrentTabId,
    getWs: getWs,
    setWs: setWs,
    getReconnectTimer: getReconnectTimer,
    setReconnectTimer: setReconnectTimer,
    clearReconnectTimer: clearReconnectTimer,
    hasConnectedClient: hasConnectedClient,
    setHasConnectedClient: setHasConnectedClient,
    addCDPClient: addCDPClient,
    removeCDPClient: removeCDPClient,
    getCDPClients: getCDPClients,
    setCDPClients: setCDPClients,
    addPendingCreatedTabUrl: addPendingCreatedTabUrl,
    removePendingCreatedTabUrl: removePendingCreatedTabUrl,
    hasPendingCreatedTabUrl: hasPendingCreatedTabUrl,
    getScreencastSession: getScreencastSession,
    setScreencastSession: setScreencastSession,
    deleteScreencastSession: deleteScreencastSession,
    addAutomatedTab: addAutomatedTab,
    removeAutomatedTab: removeAutomatedTab,
    getAutomatedTabs: getAutomatedTabs,
    clearSessionState: clearSessionState,
    clearAllState: clearAllState,
    cleanupAllTabs: cleanupAllTabs,
    setTabIdToClientId: setTabIdToClientId,
    removeTabIdToClientId: removeTabIdToClientId,
    getClientIdByTabId: getClientIdByTabId,
    setGroupIdForClient: setGroupIdForClient,
    getGroupIdForClient: getGroupIdForClient,
    removeGroupForClient: removeGroupForClient,
    addPreExistingTab: addPreExistingTab,
    isPreExistingTab: isPreExistingTab,
    getPreExistingTabs: getPreExistingTabs,
    removePreExistingTab: removePreExistingTab,
    clearPreExistingTabsForClient: clearPreExistingTabsForClient
  };
})();
