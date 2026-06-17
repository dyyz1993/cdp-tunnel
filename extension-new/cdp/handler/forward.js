var ForwardHandler = (function() {
  // 合成输入事件（keyboard/mouse）需要页面 visibility=visible 才能投递到 DOM。
  // cdp-tunnel 的隔离 tab（active:false + 折叠分组）默认 visibility=hidden，
  // 导致 Input.dispatchKeyEvent/dispatchMouseEvent 被 Chromium 丢弃。
  // 这些命令发送前需要 Page.bringToFront 让页面变 visible + 恢复焦点。
  var SYNTHETIC_INPUT_METHODS = [
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent'
  ];

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

    // 合成输入事件需要页面 visible：先 ensureVisible 再发命令
    if (SYNTHETIC_INPUT_METHODS.indexOf(method) >= 0) {
      return ensureVisible(tabId).then(function() {
        return chrome.debugger.sendCommand({ tabId: tabId }, method, params);
      }).then(function(result) {
        return result || {};
      });
    }

    return chrome.debugger.sendCommand({ tabId: tabId }, method, params).then(function(result) {
      return result || {};
    });
  }

  /**
   * 让 tab 变 visible：Page.bringToFront + 等 visibilitychange + 恢复焦点。
   * bringToFront 会重置页面元素焦点，需要保存/恢复。
   */
  function ensureVisible(tabId) {
    // 1. 保存焦点：给 activeElement 打标记
    return chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
      expression: '(function(){var el=document.activeElement;if(el&&el!==document.body&&el.focus){el.setAttribute("data-cdp-saved-focus","1");return 1}return 0})()',
      returnByValue: true
    }).catch(function() { return { result: { value: 0 } }; }).then(function(res) {
      var hadFocus = res && res.result && res.result.value;

      // 2. bringToFront 让 visibility 从 hidden→visible
      return chrome.debugger.sendCommand({ tabId: tabId }, 'Page.bringToFront', {}).then(function() {
        // 3. 等 visibilitychange 事件 + 双 rAF（确保 renderer 完成切换）
        return chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
          expression: 'new Promise(function(r){function ok(){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1)})})}if(document.visibilityState==="visible"){ok()}else{var d=function(){if(document.visibilityState==="visible"){document.removeEventListener("visibilitychange",d);ok()}};document.addEventListener("visibilitychange",d);setTimeout(function(){document.removeEventListener("visibilitychange",d);ok()},3000)}})',
          awaitPromise: true
        });
      }).then(function() {
        // 4. 恢复焦点
        if (hadFocus) {
          return chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
            expression: '(function(){var el=document.querySelector("[data-cdp-saved-focus]");if(el){el.removeAttribute("data-cdp-saved-focus");el.focus();return 1}return 0})()',
            returnByValue: true
          }).catch(function() {});
        }
      });
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
