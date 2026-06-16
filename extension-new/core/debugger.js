var DebuggerManager = (function() {
  var INTERNAL_URL_BLOCK_SCRIPT = `
(function() {
  if (window.__internalUrlBlockInjected) return;
  window.__internalUrlBlockInjected = true;
  
  var blockedProtocols = ['bitbrowser:', 'chrome:', 'edge:', 'chrome-extension:', 'bytedance:', 'sslocal:', 'alipays:', 'weixin:', 'mqq:', 'taobao:', 'tmall:'];
  
  function isInternalUrl(url) {
    if (!url) return false;
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) {
      return false;
    }
    for (var i = 0; i < blockedProtocols.length; i++) {
      if (url.startsWith(blockedProtocols[i])) {
        return true;
      }
    }
    var colonIdx = url.indexOf(':');
    if (colonIdx > 0 && colonIdx < 20 && url.substring(colonIdx, colonIdx + 3) === '://') {
      return true;
    }
    return false;
  }
  
  var originalCreateElement = document.createElement;
  document.createElement = function(tagName) {
    var element = originalCreateElement.call(document, tagName);
    if (tagName.toLowerCase() === 'iframe') {
      var originalSetAttribute = element.setAttribute;
      element.setAttribute = function(name, value) {
        if (name.toLowerCase() === 'src' && isInternalUrl(String(value || ''))) {
          console.warn('[CDP-BLOCK] Blocked iframe src:', value);
          return element;
        }
        return originalSetAttribute.call(this, name, value);
      };
    }
    return element;
  };
  
  var originalWindowOpen = window.open;
  window.open = function(url) {
    if (isInternalUrl(url)) {
      console.warn('[CDP-BLOCK] Blocked window.open:', url);
      return null;
    }
    return originalWindowOpen.apply(this, arguments);
  };
  
  var locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  if (locationDescriptor && typeof locationDescriptor.set === 'function') {
    try {
      Object.defineProperty(window, 'location', {
        set: function(value) {
          if (isInternalUrl(String(value))) {
            console.warn('[CDP-BLOCK] Blocked location change:', value);
            return;
          }
          locationDescriptor.set.call(window, value);
        },
        get: function() {
          return locationDescriptor.get.call(window);
        },
        configurable: true
      });
    } catch(e) {
    }
  }
  
  console.log('[CDP-BLOCK] Internal URL block script injected');
})();
`;

  // 跟踪每个 tab 最后一次非 about:blank 的导航 url
  // 用于过滤 attach 时 Chrome 重放的 about:blank frameNavigated 事件
  var tabLastRealUrl = {};

  function attach(tabId, connState) {
    var state = connState || _getAnyStateForTab(tabId);
    if (tabId == null) {
      return Promise.resolve(false);
    }

    return ensureTabExists(tabId).then(function(exists) {
      if (!exists) {
        Logger.warn('[Debugger] Tab', tabId, 'does not exist');
        if (state) state.persist(null, false);
        return false;
      }

      return getActualAttachState(tabId).then(function(isAttached) {
        if (isAttached) {
          Logger.info('[Debugger] Tab', tabId, 'already attached, detaching first...');
          return chrome.debugger.detach({ tabId: tabId }).catch(function() {}).then(function() {
            return doAttach(tabId, state);
          });
        }
        return doAttach(tabId, state);
      });
    });
  }

  function _getAnyStateForTab(tabId) {
    var entry = ConnectionManager.getConnectionByTabId(tabId);
    return entry ? entry.state : null;
  }

  function doAttach(tabId, state) {
    return chrome.debugger.attach({ tabId: tabId }, Config.DEBUGGER_VERSION)
      .then(function() {
        Logger.info('[Debugger] Attached to tab', tabId);
        if (state) {
          state.addAttachedTab(tabId);
          state.setCurrentTabId(tabId);
          state.persist(tabId, true);
        }
        return injectInternalUrlBlocker(tabId);
      })
      .then(function() {
        return true;
      })
      .catch(function(error) {
        Logger.error('[Debugger] Failed to attach to tab', tabId, ':', error.message);
        return false;
      });
  }

  function injectInternalUrlBlocker(tabId) {
    return chrome.debugger.sendCommand(
      { tabId: tabId },
      'Runtime.evaluate',
      { 
        expression: INTERNAL_URL_BLOCK_SCRIPT,
        runImmediately: true
      }
    ).then(function(result) {
      if (result.exceptionDetails) {
        Logger.warn('[Debugger] Failed to inject internal URL blocker:', result.exceptionDetails);
      } else {
        Logger.info('[Debugger] Internal URL blocker injected');
      }
    }).catch(function(e) {
      Logger.warn('[Debugger] Failed to inject internal URL blocker:', e.message);
    });
  }

  function detach(tabId, connState) {
    var state = connState || _getAnyStateForTab(tabId);
    if (tabId == null) {
      return Promise.resolve();
    }

    Logger.info('[Debugger] Attempting to detach from tab', tabId);

    return chrome.debugger.detach({ tabId: tabId })
      .then(function() {
        Logger.info('[Debugger] Detached from tab', tabId);
        if (state) {
          state.removeAttachedTab(tabId);
          if (state.getCurrentTabId() === tabId) {
            state.persist(null, false);
          }
        }
        AutomationBadge.remove(tabId);
        Screencast.stopPolling(tabId);
      })
      .catch(function(error) {
        Logger.error('[Debugger] Failed to detach from tab', tabId, ':', error.message);
        if (state) state.removeAttachedTab(tabId);
        AutomationBadge.remove(tabId);
        Screencast.stopPolling(tabId);
      });
  }

  function isAttached(tabId) {
    return getActualAttachState(tabId);
  }

  function getActualAttachState(tabId) {
    return chrome.debugger.getTargets().then(function(targets) {
      var target = targets.find(function(t) {
        return t.tabId === tabId;
      });
      return target ? target.attached : false;
    });
  }

  function ensureTabExists(tabId) {
    return new Promise(function(resolve) {
      chrome.tabs.get(tabId, function(tab) {
        resolve(!!(tab && tab.id));
      });
    }).catch(function() {
      return false;
    });
  }

  function handleDebuggerEvent(source, method, params) {
    var entry = ConnectionManager.getConnectionByTabId(source.tabId);
    if (!entry) return;

    var state = entry.state;
    var wsManager = entry.wsManager;

    if (!state.isTabAttached(source.tabId)) {
      return;
    }

    if (!state.hasConnectedClient()) {
      return;
    }

    if (method === 'Target.targetCreated' || method === 'Target.attachedToTarget' || method === 'Target.targetDestroyed') {
      return;
    }

    var sessionIds = state.findSessionsByTabId(source.tabId);
    Logger.info('[Event] method=' + method + ' tabId=' + source.tabId + ' sessions=' + sessionIds.length);

    if (method === 'Runtime.executionContextCreated' && params && params.context) {
      var context = params.context;
      var isPlaywrightContext = context.name && context.name.indexOf('__playwright') === 0;
      var isDefaultContext = context.auxData && context.auxData.isDefault;

      if (!isPlaywrightContext && !isDefaultContext) {
        Logger.info('[Event] Filtering non-Playwright Runtime.executionContextCreated:', context.name);
        return;
      }

      if (isDefaultContext) {
        chrome.tabs.get(source.tabId, function(tab) {
          if (chrome.runtime.lastError) return;
          var tabUrl = tab ? (tab.url || tab.pendingUrl || '') : '';
          if (tabUrl.startsWith('data:')) return;
          chrome.debugger.sendCommand(
            { tabId: source.tabId },
            'Runtime.evaluate',
            { 
              expression: INTERNAL_URL_BLOCK_SCRIPT,
              contextId: context.id,
              runImmediately: true
            }
          ).catch(function() {});
        });
      }
    }

    if (method === 'Page.frameRequestedNavigation' && params) {
      var url = params.url || '';
      var reason = params.reason || '';
      var disposition = params.disposition || '';
      var frameId = params.frameId || '';
      Logger.warn('[NAVIGATION] frameRequestedNavigation:');
      Logger.warn('  URL:', url);
      Logger.warn('  Reason:', reason);
      Logger.warn('  Disposition:', disposition);
      Logger.warn('  FrameId:', frameId);

      if (url && !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('file://')) {
        Logger.error('[NAVIGATION] ⚠️ 检测到导航到内部页面，尝试阻止!');
        Logger.error('[NAVIGATION] 目标URL:', url);

        chrome.debugger.sendCommand(
          { tabId: source.tabId },
          'Page.stopLoading',
          {}
        ).then(function() {
          Logger.info('[NAVIGATION] 已发送 Page.stopLoading 命令');
        }).catch(function(e) {
          Logger.error('[NAVIGATION] Page.stopLoading 失败:', e.message);
        });

        chrome.tabs.get(source.tabId, function(tab) {
          if (tab && tab.url && !tab.url.startsWith('bitbrowser://')) {
            Logger.info('[NAVIGATION] 尝试导航回原页面:', tab.url);
            setTimeout(function() {
              chrome.debugger.sendCommand(
                { tabId: source.tabId },
                'Page.navigate',
                { url: tab.url }
              ).then(function() {
                Logger.info('[NAVIGATION] 已导航回原页面');
              }).catch(function(e) {
                Logger.error('[NAVIGATION] Page.navigate 失败:', e.message);
              });
            }, 100);
          }
        });

        Logger.warn('[NAVIGATION] 阻止转发导航事件到客户端');
        return;
      }
    }

    // 过滤 attach 时 Chrome 重放的 about:blank frameNavigated 事件
    // 原生 Chrome CDP 中，navigate 成功后不会回退到 about:blank
    if (method === 'Page.frameNavigated' && params && params.frame) {
      var navUrl = params.frame.url || '';
      var tabIdKey = String(source.tabId);

      if (navUrl && navUrl !== 'about:blank') {
        // 记录真实导航 url
        tabLastRealUrl[tabIdKey] = navUrl;
      } else if (navUrl === 'about:blank' && tabLastRealUrl[tabIdKey]) {
        // tab 已经导航到真实 url，但收到 about:blank 的 frameNavigated
        // 这是 attach 时 Chrome 重放的旧事件，过滤掉
        Logger.info('[Event] Filtering stale about:blank frameNavigated for tab', source.tabId, '(real url:', tabLastRealUrl[tabIdKey] + ')');
        return;
      }
    }

    for (var i = 0; i < sessionIds.length; i++) {
      EventBuilder.send(method, params, sessionIds[i], wsManager);
    }
  }

  function handleDetach(source, reason) {
    Logger.info('[Debugger] Detached from tab', source.tabId, ', reason:', reason);

    delete tabLastRealUrl[String(source.tabId)];

    var entry = ConnectionManager.getConnectionByTabId(source.tabId);
    var state = entry ? entry.state : null;
    var wsManager = entry ? entry.wsManager : null;

    if (state) {
      state.removeAttachedTab(source.tabId);
    }
    Screencast.stopPolling(source.tabId);
    AutomationBadge.remove(source.tabId);

    if (state) {
      var sessionId = state.findSessionByTabId(source.tabId);
      if (sessionId) {
        var targetId = state.getTargetIdBySession(sessionId);
        EventBuilder.send('Target.detachedFromTarget', {
          sessionId: sessionId,
          targetId: targetId
        }, null, wsManager);
        state.unmapSession(sessionId);
      }

      if (state.getCurrentTabId() === source.tabId) {
        state.persist(null, false);
      }
    }
  }

  return {
    attach: attach,
    detach: detach,
    isAttached: isAttached,
    getActualAttachState: getActualAttachState,
    handleDebuggerEvent: handleDebuggerEvent,
    handleDetach: handleDetach
  };
})();
