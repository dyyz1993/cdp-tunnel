var LocalHandler = (function() {
  function browserGetVersion() {
    var userAgent = navigator.userAgent || '';
    var chromeVersion = CDPUtils.getChromeVersion(userAgent);
    return {
      protocolVersion: '1.3',
      product: chromeVersion ? 'Chrome/' + chromeVersion : 'Chrome',
      revision: '',
      userAgent: userAgent,
      jsVersion: ''
    };
  }

  function browserClose() {
    return State.cleanupAllTabs().then(function() {
      return {};
    });
  }

  function getWindowForTarget() {
    return {
      windowId: 1,
      bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }
    };
  }

  function getWindowBounds() {
    return {
      bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }
    };
  }

  function targetSetDiscoverTargets(params) {
    State.setDiscoverTargets(!!(params && params.discover));
    
    if (params && params.discover) {
      return getTargetInfos().then(function(targets) {
        targets.forEach(function(targetInfo) {
          EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo });
        });
        return {};
      });
    }
    return Promise.resolve({});
  }

  function targetGetTargets() {
    return getTargetInfos().then(function(targetInfos) {
      return { targetInfos: targetInfos };
    });
  }

  function targetGetTargetInfo(params) {
    return getFallbackTargetId().then(function(fallbackId) {
      var targetId = (params && params.targetId) || fallbackId;
      if (!targetId) {
        throw new Error('targetId is required');
      }
      return getTargetInfoById(targetId).then(function(targetInfo) {
        if (!targetInfo) {
          throw new Error('Target not found');
        }
        return { targetInfo: targetInfo };
      });
    });
  }

  function targetCreateBrowserContext() {
    var browserContextId = 'context-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    State.addBrowserContext(browserContextId);
    return { browserContextId: browserContextId };
  }

  function targetGetBrowserContexts() {
    return { browserContextIds: State.getBrowserContexts() };
  }

  function targetDisposeBrowserContext(params) {
    if (params && params.browserContextId) {
      State.removeBrowserContext(params.browserContextId);
    }
    return {};
  }

  function targetAttachToBrowserTarget() {
    return { sessionId: 'browser-session' };
  }

  function systemInfoGetInfo() {
    return {
      gpu: { devices: [], drivers: [], auxAttributes: {}, featureStatus: {} },
      modelName: 'CDP Bridge',
      modelVersion: '1.0.0',
      commandLine: ''
    };
  }

  function systemInfoGetProcessInfo() {
    return { processInfo: [] };
  }

  function tetheringBind() {
    return { port: 0 };
  }

  function ioRead() {
    return { data: '', eof: true };
  }

  function ioResolveBlob() {
    return { uuid: 'mock-uuid' };
  }

  function schemaGetDomains() {
    return {
      domains: [
        { name: 'Page', version: '1.0' },
        { name: 'Runtime', version: '1.0' },
        { name: 'Network', version: '1.0' },
        { name: 'DOM', version: '1.0' },
        { name: 'Target', version: '1.0' }
      ]
    };
  }

  function emptyResult() {
    return {};
  }

  function emptyArray() {
    return { items: [] };
  }

  function emptyObject() {
    return {};
  }

  function getTargetInfos() {
    return chrome.debugger.getTargets().then(function(targets) {
      return targets.map(mapToTargetInfo).filter(Boolean);
    });
  }

  function getTargetInfoById(targetId) {
    return chrome.debugger.getTargets().then(function(targets) {
      var match = targets.find(function(t) {
        return t.id === targetId || String(t.tabId) === String(targetId);
      });
      return match ? mapToTargetInfo(match) : null;
    });
  }

  function getFallbackTargetId() {
    var currentTabId = State.getCurrentTabId();
    if (currentTabId != null) {
      return ensureTabExists(currentTabId).then(function(exists) {
        if (exists) return String(currentTabId);
        return getActiveTabId().then(function(activeId) {
          if (activeId != null) return String(activeId);
          return getTargetInfos().then(function(infos) {
            var page = infos.find(function(t) { return t.type === 'page'; });
            return page ? page.targetId : null;
          });
        });
      });
    }
    return getActiveTabId().then(function(activeId) {
      if (activeId != null) return String(activeId);
      return getTargetInfos().then(function(infos) {
        var page = infos.find(function(t) { return t.type === 'page'; });
        return page ? page.targetId : null;
      });
    });
  }

  function getActiveTabId() {
    return new Promise(function(resolve) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function(tabs) {
        resolve(tabs[0] ? tabs[0].id : null);
      });
    });
  }

  function ensureTabExists(tabId) {
    if (tabId == null) return Promise.resolve(false);
    return new Promise(function(resolve) {
      chrome.tabs.get(tabId, function(tab) {
        resolve(!!(tab && tab.id));
      });
    }).catch(function() {
      return false;
    });
  }

  function mapToTargetInfo(target) {
    if (!target) return null;
    return {
      targetId: target.id || String(target.tabId),
      type: target.type || 'page',
      title: target.title || '',
      url: target.url || '',
      attached: !!target.attached,
      canAccessOpener: false,
      browserContextId: 'default'
    };
  }

  return {
    browserGetVersion: browserGetVersion,
    browserClose: browserClose,
    getWindowForTarget: getWindowForTarget,
    getWindowBounds: getWindowBounds,
    targetSetDiscoverTargets: targetSetDiscoverTargets,
    targetGetTargets: targetGetTargets,
    targetGetTargetInfo: targetGetTargetInfo,
    targetCreateBrowserContext: targetCreateBrowserContext,
    targetGetBrowserContexts: targetGetBrowserContexts,
    targetDisposeBrowserContext: targetDisposeBrowserContext,
    targetAttachToBrowserTarget: targetAttachToBrowserTarget,
    systemInfoGetInfo: systemInfoGetInfo,
    systemInfoGetProcessInfo: systemInfoGetProcessInfo,
    tetheringBind: tetheringBind,
    ioRead: ioRead,
    ioResolveBlob: ioResolveBlob,
    schemaGetDomains: schemaGetDomains,
    emptyResult: emptyResult,
    emptyArray: emptyArray,
    emptyObject: emptyObject,
    getTargetInfos: getTargetInfos,
    getTargetInfoById: getTargetInfoById,
    mapToTargetInfo: mapToTargetInfo
  };
})();
