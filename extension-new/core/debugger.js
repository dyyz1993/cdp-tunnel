var DebuggerManager = (function() {
  var INTERNAL_URL_BLOCK_SCRIPT = `
(function() {
  if (window.__internalUrlBlockInjected) return;
  window.__internalUrlBlockInjected = true;
  
  var blockedProtocols = ['bitbrowser:', 'chrome:', 'edge:', 'chrome-extension:', 'bytedance:', 'sslocal:', 'alipays:', 'weixin:', 'mqq:', 'taobao:', 'tmall:'];
  
  function isInternalUrl(url) {
    if (!url) return false;
    // Whitelist: only allow http/https/about/data/blob/file
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) {
      return false;
    }
    // Also check explicit blocked list for common custom protocols
    for (var i = 0; i < blockedProtocols.length; i++) {
      if (url.startsWith(blockedProtocols[i])) {
        return true;
      }
    }
    // Block any other custom protocol (xxx://)
    var colonIdx = url.indexOf(':');
    if (colonIdx > 0 && colonIdx < 20 && url.substring(colonIdx, colonIdx + 3) === '://') {
      return true;
    }
    return false;
  }
  
  // 拦截 iframe 创建
  var originalCreateElement = document.createElement;
  document.createElement = function(tagName) {
    var element = originalCreateElement.call(document, tagName);
    if (tagName.toLowerCase() === 'iframe') {
      var originalSetAttribute = element.setAttribute;
      element.setAttribute = function(name, value) {
        if (name.toLowerCase() === 'src' && isInternalUrl(value)) {
          console.warn('[CDP-BLOCK] Blocked iframe src:', value);
          return;
        }
        return originalSetAttribute.call(this, name, value);
      };
      
      Object.defineProperty(element, 'src', {
        set: function(value) {
          if (isInternalUrl(value)) {
            console.warn('[CDP-BLOCK] Blocked iframe src via property:', value);
            return;
          }
          originalSetAttribute.call(this, 'src', value);
        },
        get: function() {
          return element.getAttribute('src');
        }
      });
    }
    return element;
  };
  
  // 拦截 window.open
  var originalWindowOpen = window.open;
  window.open = function(url) {
    if (isInternalUrl(url)) {
      console.warn('[CDP-BLOCK] Blocked window.open:', url);
      return null;
    }
    return originalWindowOpen.apply(this, arguments);
  };
  
  // 拦截 location 修改
  var locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
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
    }
  });
  
  console.log('[CDP-BLOCK] Internal URL block script injected');
})();
`;

  function attach(tabId) {
    if (tabId == null) {
      return Promise.resolve(false);
    }

    return ensureTabExists(tabId).then(function(exists) {
      if (!exists) {
        Logger.warn('[Debugger] Tab', tabId, 'does not exist');
        State.persist(null, false);
        return false;
      }

      return getActualAttachState(tabId).then(function(isAttached) {
        if (isAttached) {
          Logger.info('[Debugger] Tab', tabId, 'already attached, detaching first...');
          return chrome.debugger.detach({ tabId: tabId }).catch(function() {}).then(function() {
            return doAttach(tabId);
          });
        }
        return doAttach(tabId);
      });
    });
  }

  function doAttach(tabId) {
    return chrome.debugger.attach({ tabId: tabId }, Config.DEBUGGER_VERSION)
      .then(function() {
        Logger.info('[Debugger] Attached to tab', tabId);
        State.addAttachedTab(tabId);
        State.setCurrentTabId(tabId);
        State.persist(tabId, true);
        
        // 注入内部URL拦截脚本
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

  function detach(tabId) {
    if (tabId == null) {
      return Promise.resolve();
    }

    Logger.info('[Debugger] Attempting to detach from tab', tabId);

    return chrome.debugger.detach({ tabId: tabId })
      .then(function() {
        Logger.info('[Debugger] Detached from tab', tabId);
        State.removeAttachedTab(tabId);
        AutomationBadge.remove(tabId);
        Screencast.stopPolling(tabId);
        if (State.getCurrentTabId() === tabId) {
          State.persist(null, false);
        }
      })
      .catch(function(error) {
        Logger.error('[Debugger] Failed to detach from tab', tabId, ':', error.message);
        State.removeAttachedTab(tabId);
        AutomationBadge.remove(tabId);
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
    if (!State.isTabAttached(source.tabId)) {
      return;
    }

    if (!State.hasConnectedClient()) {
      return;
    }

    var sessionId = State.findSessionByTabId(source.tabId);
    Logger.info('[Event] method=' + method + ' tabId=' + source.tabId + ' sessionId=' + (sessionId || 'null'));
    
    if (method === 'Runtime.executionContextCreated' && params && params.context) {
      var context = params.context;
      var isPlaywrightContext = context.name && context.name.indexOf('__playwright') === 0;
      var isDefaultContext = context.auxData && context.auxData.isDefault;
      
      if (!isPlaywrightContext && !isDefaultContext) {
        Logger.info('[Event] Filtering non-Playwright Runtime.executionContextCreated:', context.name);
        return;
      }
      
      // 在新的执行上下文中也注入拦截脚本
      if (isDefaultContext) {
        chrome.debugger.sendCommand(
          { tabId: source.tabId },
          'Runtime.evaluate',
          { 
            expression: INTERNAL_URL_BLOCK_SCRIPT,
            contextId: context.id,
            runImmediately: true
          }
        ).catch(function() {});
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
        
        // 尝试方法1: 停止页面加载
        chrome.debugger.sendCommand(
          { tabId: source.tabId },
          'Page.stopLoading',
          {}
        ).then(function() {
          Logger.info('[NAVIGATION] 已发送 Page.stopLoading 命令');
        }).catch(function(e) {
          Logger.error('[NAVIGATION] Page.stopLoading 失败:', e.message);
        });
        
        // 尝试方法2: 获取当前页面URL并导航回去
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
        
        // 不转发这个导航事件给客户端
        Logger.warn('[NAVIGATION] 阻止转发导航事件到客户端');
        return;
      }
    }
    
    EventBuilder.send(method, params, sessionId);
  }

  function handleDetach(source, reason) {
    Logger.info('[Debugger] Detached from tab', source.tabId, ', reason:', reason);
    State.removeAttachedTab(source.tabId);
    Screencast.stopPolling(source.tabId);
    AutomationBadge.remove(source.tabId);

    var sessionId = State.findSessionByTabId(source.tabId);
    if (sessionId) {
      var targetId = State.getTargetIdBySession(sessionId);
      EventBuilder.send('Target.detachedFromTarget', {
        sessionId: sessionId,
        targetId: targetId
      });
      State.unmapSession(sessionId);
    }

    if (State.getCurrentTabId() === source.tabId) {
      State.persist(null, false);
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
