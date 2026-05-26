var State = (function() {
  var _state = {
    currentTabId: null,
    isAttached: false
  };

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

  function getAttachedTabIds() {
    var tabs = [];
    ConnectionManager.forEachConnection(function(entry) {
      tabs = tabs.concat(entry.state.getAttachedTabIds());
    });
    return tabs;
  }

  function getCDPClients() {
    var clients = [];
    ConnectionManager.forEachConnection(function(entry) {
      clients = clients.concat(entry.state.getCDPClients() || []);
    });
    return clients;
  }

  function findSessionByTabId(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state.findSessionByTabId(tabId) : null;
  }

  function getWs() {
    var entry = ConnectionManager.getPrimaryConnection();
    return entry ? entry.state.getWs() : null;
  }

  function clearAllState() {
    ConnectionManager.forEachConnection(function(entry) {
      entry.state.clearAllState();
    });
  }

  function persist(tabId, attached) {
    _state.currentTabId = tabId;
    _state.isAttached = attached;
    return new Promise(function(resolve) {
      chrome.storage.local.set({ currentTabId: tabId, isAttached: attached }, resolve);
    });
  }

  function isTabAttached(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state.isTabAttached(tabId) : false;
  }

  function removeAttachedTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.removeAttachedTab(tabId);
  }

  function hasConnectedClient() {
    var result = false;
    ConnectionManager.forEachConnection(function(entry) {
      if (entry.state.hasConnectedClient()) result = true;
    });
    return result;
  }

  function getClientIdByTabId(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state.getClientIdByTabId(tabId) : undefined;
  }

  function isCDPCreatedTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state.isCDPCreatedTab(tabId) : false;
  }

  function isPreExistingTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state.isPreExistingTab(tabId) : false;
  }

  function addAttachedTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.addAttachedTab(tabId);
  }

  function addCDPCreatedTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.addCDPCreatedTab(tabId);
  }

  function getScreencastSession(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state.getScreencastSession(tabId) : null;
  }

  function setScreencastSession(tabId, session) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.setScreencastSession(tabId, session);
  }

  function deleteScreencastSession(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.deleteScreencastSession(tabId);
  }

  function removeAutomatedTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.removeAutomatedTab(tabId);
  }

  function addAutomatedTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    if (entry) entry.state.addAutomatedTab(tabId);
  }

  function getAutomatedTabs() {
    var tabs = [];
    ConnectionManager.forEachConnection(function(entry) {
      tabs = tabs.concat(entry.state.getAutomatedTabs());
    });
    return tabs;
  }

  return {
    loadPersisted: loadPersisted,
    persist: persist,
    getCurrentTabId: getCurrentTabId,
    setCurrentTabId: setCurrentTabId,
    getAttachedTabIds: getAttachedTabIds,
    getCDPClients: getCDPClients,
    findSessionByTabId: findSessionByTabId,
    getWs: getWs,
    clearAllState: clearAllState,
    isTabAttached: isTabAttached,
    removeAttachedTab: removeAttachedTab,
    hasConnectedClient: hasConnectedClient,
    getClientIdByTabId: getClientIdByTabId,
    isCDPCreatedTab: isCDPCreatedTab,
    isPreExistingTab: isPreExistingTab,
    addAttachedTab: addAttachedTab,
    addCDPCreatedTab: addCDPCreatedTab,
    removeAutomatedTab: removeAutomatedTab,
    addAutomatedTab: addAutomatedTab,
    getAutomatedTabs: getAutomatedTabs,
    getScreencastSession: getScreencastSession,
    setScreencastSession: setScreencastSession,
    deleteScreencastSession: deleteScreencastSession
  };
})();
