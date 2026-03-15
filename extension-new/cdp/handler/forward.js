var ForwardHandler = (function() {
  function execute(context) {
    var id = context.id;
    var method = context.method;
    var params = context.params;
    var sessionId = context.sessionId;

    var tabId = resolveTabId(sessionId);

    if (!tabId) {
      Logger.warn('[Forward] No tabId for command:', method);
      return Promise.resolve({});
    }

    if (!State.isTabAttached(tabId)) {
      Logger.warn('[Forward] Tab not attached, skipping command:', method, 'tabId:', tabId);
      return Promise.resolve({});
    }

    Logger.debug('[Forward]', method, '-> tabId:', tabId);
    return chrome.debugger.sendCommand({ tabId: tabId }, method, params).then(function(result) {
      return result || {};
    });
  }

  function resolveTabId(sessionId) {
    if (sessionId) {
      return State.getTabIdBySession(sessionId);
    }
    var currentTabId = State.getCurrentTabId();
    if (currentTabId != null && State.isTabAttached(currentTabId)) {
      return currentTabId;
    }
    var attachedTabs = State.getAttachedTabIds();
    if (attachedTabs.length > 0) {
      return attachedTabs[0];
    }
    return null;
  }

  return {
    execute: execute
  };
})();
