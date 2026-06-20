function ConnectionState(connectionId, mode) {
  this.connectionId = connectionId;
  this.mode = mode || 'create';
  this.connectionTag = null;
  this.clientIdToTag = new Map();
  this.ws = null;
  this.reconnectTimer = null;
  this._hasConnectedClient = false;
  this.cdpClients = [];
  this.currentTabId = null;
  this.isAttached = false;

  this.sessionIdToTabId = new Map();
  this.sessionIdToTargetId = new Map();
  this.tabIdToClientId = new Map();
  this.clientIdToGroupId = new Map();
  this.attachedTabIds = new Set();
  this.cdpCreatedTabIds = new Set();
  this.emittedTargets = new Set();
  this.pendingCreatedTabUrls = new Set();
  this.preExistingTabIds = new Set();
  this.pendingDebuggerTabs = new Set();
  this.autoAttachConfig = {
    autoAttach: false,
    waitForDebuggerOnStart: false,
    flatten: true
  };
  this.discoverTargetsEnabled = false;
  this.browserContextIds = new Set(['default']);
  this.screencastPollingSessions = new Map();
  this.automatedTabs = new Set();
  this._groupCreationPromises = new Map();
}

ConnectionState.prototype.mapSession = function(sessionId, tabId, targetId) {
  this.sessionIdToTabId.set(sessionId, tabId);
  this.sessionIdToTargetId.set(sessionId, targetId);
  this.attachedTabIds.add(tabId);
};

ConnectionState.prototype.unmapSession = function(sessionId) {
  var tabId = this.sessionIdToTabId.get(sessionId);
  this.sessionIdToTabId.delete(sessionId);
  this.sessionIdToTargetId.delete(sessionId);
  if (tabId && !this.hasOtherSessionForTab(tabId)) {
    this.attachedTabIds.delete(tabId);
  }
  return tabId;
};

ConnectionState.prototype.getTabIdBySession = function(sessionId) {
  return this.sessionIdToTabId.get(sessionId);
};

ConnectionState.prototype.getTargetIdBySession = function(sessionId) {
  return this.sessionIdToTargetId.get(sessionId);
};

ConnectionState.prototype.findSessionByTabId = function(tabId) {
  var lastMatch = null;
  this.sessionIdToTabId.forEach(function(mappedTabId, sessionId) {
    if (mappedTabId === tabId) lastMatch = sessionId;
  });
  return lastMatch;
};

ConnectionState.prototype.findSessionsByTabId = function(tabId) {
  var sessions = [];
  this.sessionIdToTabId.forEach(function(mappedTabId, sessionId) {
    if (mappedTabId === tabId) sessions.push(sessionId);
  });
  return sessions;
};

ConnectionState.prototype.findSessionByTargetId = function(targetId) {
  var entries = this.sessionIdToTargetId.entries();
  var entry = entries.next();
  while (!entry.done) {
    if (entry.value[1] === targetId) return entry.value[0];
    entry = entries.next();
  }
  return null;
};

ConnectionState.prototype.getTabIdByTargetId = function(targetId) {
  var sessionId = this.findSessionByTargetId(targetId);
  if (sessionId) return this.sessionIdToTabId.get(sessionId);
  return null;
};

ConnectionState.prototype.hasOtherSessionForTab = function(tabId) {
  var count = 0;
  this.sessionIdToTabId.forEach(function(mappedTabId) {
    if (mappedTabId === tabId) count++;
  });
  return count > 0;
};

ConnectionState.prototype.addAttachedTab = function(tabId) {
  this.attachedTabIds.add(tabId);
};

ConnectionState.prototype.removeAttachedTab = function(tabId) {
  this.attachedTabIds.delete(tabId);
};

ConnectionState.prototype.isTabAttached = function(tabId) {
  return this.attachedTabIds.has(tabId);
};

ConnectionState.prototype.getAttachedTabIds = function() {
  return Array.from(this.attachedTabIds);
};

ConnectionState.prototype.addEmittedTarget = function(targetId) {
  this.emittedTargets.add(targetId);
};

ConnectionState.prototype.hasEmittedTarget = function(targetId) {
  return this.emittedTargets.has(targetId);
};

ConnectionState.prototype.setAutoAttachConfig = function(config) {
  Object.assign(this.autoAttachConfig, config);
};

ConnectionState.prototype.getAutoAttachConfig = function() {
  return Object.assign({}, this.autoAttachConfig);
};

ConnectionState.prototype.setDiscoverTargets = function(enabled) {
  this.discoverTargetsEnabled = enabled;
};

ConnectionState.prototype.addPendingDebuggerTab = function(tabId) {
  this.pendingDebuggerTabs.add(tabId);
};

ConnectionState.prototype.removePendingDebuggerTab = function(tabId) {
  this.pendingDebuggerTabs.delete(tabId);
};

ConnectionState.prototype.isPendingDebuggerTab = function(tabId) {
  return this.pendingDebuggerTabs.has(tabId);
};

ConnectionState.prototype.addBrowserContext = function(id) {
  this.browserContextIds.add(id);
};

ConnectionState.prototype.removeBrowserContext = function(id) {
  this.browserContextIds.delete(id);
};

ConnectionState.prototype.getBrowserContexts = function() {
  return Array.from(this.browserContextIds);
};

ConnectionState.prototype.getCurrentTabId = function() {
  return this.currentTabId;
};

ConnectionState.prototype.setCurrentTabId = function(tabId) {
  this.currentTabId = tabId;
};

ConnectionState.prototype.getWs = function() {
  return this.ws;
};

ConnectionState.prototype.setWs = function(ws) {
  this.ws = ws;
};

ConnectionState.prototype.clearReconnectTimer = function() {
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
};

ConnectionState.prototype.setReconnectTimer = function(timer) {
  this.reconnectTimer = timer;
};

ConnectionState.prototype.hasConnectedClient = function() {
  return this._hasConnectedClient;
};

ConnectionState.prototype.setHasConnectedClient = function(value) {
  this._hasConnectedClient = value;
};

ConnectionState.prototype.addPendingCreatedTabUrl = function(url) {
  this.pendingCreatedTabUrls.add(url);
};

ConnectionState.prototype.removePendingCreatedTabUrl = function(url) {
  this.pendingCreatedTabUrls.delete(url);
};

ConnectionState.prototype.hasPendingCreatedTabUrl = function(url) {
  return this.pendingCreatedTabUrls.has(url);
};

ConnectionState.prototype.addCDPCreatedTab = function(tabId) {
  this.cdpCreatedTabIds.add(tabId);
};

ConnectionState.prototype.isCDPCreatedTab = function(tabId) {
  return this.cdpCreatedTabIds.has(tabId);
};

ConnectionState.prototype.getCDPCreatedTabIds = function() {
  return Array.from(this.cdpCreatedTabIds);
};

ConnectionState.prototype.getScreencastSession = function(tabId) {
  return this.screencastPollingSessions.get(tabId);
};

ConnectionState.prototype.setScreencastSession = function(tabId, session) {
  this.screencastPollingSessions.set(tabId, session);
};

ConnectionState.prototype.deleteScreencastSession = function(tabId) {
  this.screencastPollingSessions.delete(tabId);
};

ConnectionState.prototype.addAutomatedTab = function(tabId) {
  this.automatedTabs.add(tabId);
};

ConnectionState.prototype.removeAutomatedTab = function(tabId) {
  this.automatedTabs.delete(tabId);
};

ConnectionState.prototype.getAutomatedTabs = function() {
  return Array.from(this.automatedTabs);
};

ConnectionState.prototype.setTabIdToClientId = function(tabId, clientId) {
  this.tabIdToClientId.set(tabId, clientId);
};

ConnectionState.prototype.removeTabIdToClientId = function(tabId) {
  this.tabIdToClientId.delete(tabId);
};

ConnectionState.prototype.getClientIdByTabId = function(tabId) {
  return this.tabIdToClientId.get(tabId);
};

ConnectionState.prototype.setGroupIdForClient = function(clientId, groupId) {
  this.clientIdToGroupId.set(clientId, groupId);
};

ConnectionState.prototype.getGroupIdForClient = function(clientId) {
  return this.clientIdToGroupId.get(clientId);
};

ConnectionState.prototype.removeGroupForClient = function(clientId) {
  this.clientIdToGroupId.delete(clientId);
};

ConnectionState.prototype.setGroupCreationPromise = function(clientId, promise) {
  if (promise) {
    this._groupCreationPromises.set(clientId, promise);
  } else {
    this._groupCreationPromises.delete(clientId);
  }
};

ConnectionState.prototype.getGroupCreationPromise = function(clientId) {
  return this._groupCreationPromises.get(clientId) || null;
};

ConnectionState.prototype.addPreExistingTab = function(tabId) {
  this.preExistingTabIds.add(tabId);
};

ConnectionState.prototype.isPreExistingTab = function(tabId) {
  return this.preExistingTabIds.has(tabId);
};

ConnectionState.prototype.getPreExistingTabs = function() {
  return Array.from(this.preExistingTabIds);
};

ConnectionState.prototype.removePreExistingTab = function(tabId) {
  this.preExistingTabIds.delete(tabId);
};

ConnectionState.prototype.clearPreExistingTabsForClient = function(clientId) {
  var self = this;
  this.preExistingTabIds.forEach(function(tabId) {
    if (self.getClientIdByTabId(tabId) === clientId) {
      self.preExistingTabIds.delete(tabId);
    }
  });
};

ConnectionState.prototype.setTagForClient = function(clientId, tag) {
  if (clientId && tag) this.clientIdToTag.set(clientId, tag);
};

ConnectionState.prototype.getTagForClient = function(clientId) {
  return this.clientIdToTag.get(clientId) || null;
};

ConnectionState.prototype.addCDPClient = function(clientId, info) {
  var exists = false;
  for (var i = 0; i < this.cdpClients.length; i++) {
    if (this.cdpClients[i].id === clientId) { exists = true; break; }
  }
  if (!exists) {
    this.cdpClients.push({ id: clientId, connectedAt: Date.now() });
  }
};

ConnectionState.prototype.removeCDPClient = function(clientId) {
  var newClients = [];
  for (var i = 0; i < this.cdpClients.length; i++) {
    if (this.cdpClients[i].id !== clientId) newClients.push(this.cdpClients[i]);
  }
  this.cdpClients = newClients;
};

ConnectionState.prototype.getCDPClients = function() {
  return this.cdpClients;
};

ConnectionState.prototype.setCDPClients = function(clients) {
  this.cdpClients = clients || [];
};

ConnectionState.prototype.clearSessionState = function() {
  this.sessionIdToTabId.clear();
  this.sessionIdToTargetId.clear();
  this.pendingDebuggerTabs.clear();
  this.emittedTargets.clear();
};

ConnectionState.prototype.clearAllState = function() {
  this.clearSessionState();
  this.attachedTabIds.clear();
  this.emittedTargets.clear();
  this.screencastPollingSessions.clear();
  this.browserContextIds = new Set(['default']);
  this.autoAttachConfig = { autoAttach: false, waitForDebuggerOnStart: false, flatten: true };
  this.discoverTargetsEnabled = false;
  this._hasConnectedClient = false;
  this.tabIdToClientId.clear();
  this.clientIdToGroupId.clear();
  this.preExistingTabIds.clear();
  this.pendingDebuggerTabs.clear();
  this.automatedTabs.clear();
  this.pendingCreatedTabUrls.clear();
  this.cdpCreatedTabIds.clear();
  this.cdpClients = [];
  this._groupCreationPromises.clear();
};

ConnectionState.prototype.persist = function(tabId, attached) {
  this.currentTabId = tabId;
  this.isAttached = attached;
  return new Promise(function(resolve) {
    chrome.storage.local.set({ currentTabId: tabId, isAttached: attached }, resolve);
  }.bind(this));
};

ConnectionState.prototype.loadPersisted = function() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['currentTabId', 'isAttached'], function(result) {
      this.currentTabId = result.currentTabId || null;
      this.isAttached = result.isAttached || false;
      resolve(result);
    }.bind(this));
  }.bind(this));
};
