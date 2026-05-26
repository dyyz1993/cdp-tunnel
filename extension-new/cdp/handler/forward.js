var ForwardHandler = (function() {
  function execute(context) {
    var id = context.id;
    var method = context.method;
    var params = context.params;
    var sessionId = context.sessionId;
    var state = context._state;

    var tabId = resolveTabId(sessionId, state);

    if (!tabId) {
      Logger.warn('[Forward] No tabId for command:', method);
      return Promise.reject({ code: -32000, message: 'No target found for command: ' + method });
    }

    if (!state.isTabAttached(tabId)) {
      Logger.warn('[Forward] Tab not attached, skipping command:', method, 'tabId:', tabId);
      return Promise.reject({ code: -32000, message: 'Target is not attached' });
    }

    Logger.debug('[Forward]', method, '-> tabId:', tabId);
    return chrome.debugger.sendCommand({ tabId: tabId }, method, params).then(function(result) {
      return result || {};
    });
  }

  function resolveTabId(sessionId, state) {
    if (!state) return null;
    if (sessionId) {
      return state.getTabIdBySession(sessionId);
    }
    var currentTabId = state.getCurrentTabId();
    if (currentTabId != null && state.isTabAttached(currentTabId)) {
      return currentTabId;
    }
    var attachedTabs = state.getAttachedTabIds();
    if (attachedTabs.length > 0) {
      return attachedTabs[0];
    }
    return null;
  }

  return {
    execute: execute
  };
})();
