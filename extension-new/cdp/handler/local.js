var LocalHandler = (function() {
  function _getState(ctx) {
    return ctx._state;
  }

  function _getConnectionTag(ctx) {
    var wm = ctx._wsManager;
    return (wm && wm.config && wm.config.tag) || null;
  }

  function browserGetVersion() {
    var userAgent = navigator.userAgent || '';
    var match = userAgent.match(/Chrome\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
    var product = match ? 'Chrome/' + match[1] : 'Chrome';
    return {
      protocolVersion: '1.3',
      product: product,
      revision: '',
      userAgent: userAgent,
      jsVersion: ''
    };
  }

  function browserClose() {
    return Promise.resolve({});
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

  function targetSetDiscoverTargets(context) {
    var state = _getState(context);
    var params = context.params;
    var wsManager = context._wsManager;
    state.setDiscoverTargets(!!(params && params.discover));

    if (params && params.discover) {
      return getTargetInfos().then(function(targets) {
        targets.forEach(function(targetInfo) {
          state.addEmittedTarget(targetInfo.targetId);
          EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo }, null, wsManager);
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

  function targetCreateBrowserContext(context) {
    var state = _getState(context);
    var browserContextId = 'context-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    state.addBrowserContext(browserContextId);
    return { browserContextId: browserContextId };
  }

  function targetGetBrowserContexts(context) {
    var state = _getState(context);
    return { browserContextIds: state.getBrowserContexts() };
  }

  function targetDisposeBrowserContext(context) {
    var state = _getState(context);
    var params = context.params;
    if (params && params.browserContextId) {
      state.removeBrowserContext(params.browserContextId);
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

  function tabUngroup(context) {
    var state = _getState(context);
    var clientId = context.clientId;
    var groupId = null;
    try {
      groupId = state.getGroupIdForClient(clientId);
    } catch (e) {
      Logger.error('[TabUngroup] Error getting groupId: ' + (e.message || e));
      return Promise.resolve({ success: false, ungroupedCount: 0, error: e.message || String(e) });
    }
    if (groupId == null) {
      return Promise.resolve({ success: true, ungroupedCount: 0 });
    }
    return new Promise(function(resolve) {
      chrome.tabs.query({ groupId: groupId }, function(tabs) {
        if (chrome.runtime.lastError) {
          Logger.error('[TabUngroup] chrome.runtime.lastError: ' + chrome.runtime.lastError.message);
          resolve({ success: false, ungroupedCount: 0, error: chrome.runtime.lastError.message });
          return;
        }
        if (!tabs || tabs.length === 0) {
          resolve({ success: true, ungroupedCount: 0 });
          return;
        }
        var tabIds = tabs.map(function(tab) { return tab.id; });
        chrome.tabs.ungroup(tabIds, function() {
          if (chrome.runtime.lastError) {
            Logger.error('[TabUngroup] ungroup lastError: ' + chrome.runtime.lastError.message);
            resolve({ success: false, ungroupedCount: 0, error: chrome.runtime.lastError.message });
            return;
          }
          state.removeGroupForClient(clientId);
          resolve({ success: true, ungroupedCount: tabIds.length });
        });
      });
    });
  }

  function tabGetGroupInfo(context) {
    var state = _getState(context);
    var clientId = context.clientId;
    var cachedGroupId = null;
    var baseName = null;
    try {
      cachedGroupId = state.getGroupIdForClient(clientId);
      baseName = CDPUtils.getGroupBaseName(clientId, _getConnectionTag(context));
    } catch (e) {
      Logger.error('[TabGetGroupInfo] Error: ' + (e.message || e));
    }

    var attachedTabIds = state.getAttachedTabIds();
    var matchedTabId = null;
    for (var i = 0; i < attachedTabIds.length; i++) {
      if (state.getClientIdByTabId(attachedTabIds[i]) === clientId) {
        matchedTabId = attachedTabIds[i];
        break;
      }
    }

    if (matchedTabId == null) {
      return Promise.resolve({
        groupId: -1,
        cachedGroupId: cachedGroupId,
        baseName: baseName,
        clientId: clientId,
        tabId: null
      });
    }

    var tabId = matchedTabId;
    return new Promise(function(resolve) {
      chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError) {
          Logger.error('[TabGetGroupInfo] chrome.tabs.get error: ' + chrome.runtime.lastError.message);
          resolve({
            groupId: -1,
            cachedGroupId: cachedGroupId,
            baseName: baseName,
            clientId: clientId,
            tabId: tabId
          });
          return;
        }
        resolve({
          groupId: tab.groupId != null ? tab.groupId : -1,
          cachedGroupId: cachedGroupId,
          baseName: baseName,
          clientId: clientId,
          tabId: tabId
        });
      });
    });
  }

  function tabSimulateUserOpen(context) {
    var state = _getState(context);
    var attachedTabIds = state.getAttachedTabIds();
    var openerTabId = null;
    for (var i = 0; i < attachedTabIds.length; i++) {
      if (state.isCDPCreatedTab(attachedTabIds[i])) {
        openerTabId = attachedTabIds[i];
        break;
      }
    }
    if (openerTabId == null) {
      return Promise.resolve({ success: false, error: 'No CDP-created tab found to use as opener' });
    }
    return new Promise(function(resolve) {
      chrome.tabs.create({ url: 'https://example.com', openerTabId: openerTabId }, function(tab) {
        if (chrome.runtime.lastError) {
          Logger.error('[TabSimulateUserOpen] Error: ' + chrome.runtime.lastError.message);
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        setTimeout(function() {
          chrome.tabs.get(tab.id, function(t) {
            resolve({ success: true, newTabId: tab.id, openerTabId: openerTabId, actualOpenerTabId: t.openerTabId, actualGroupId: t.groupId });
          });
        }, 1000);
      });
    });
  }

  function tabGetTabGroup(context) {
    var tabId = context.params && context.params.tabId;
    if (tabId == null) {
      return Promise.resolve({ error: 'tabId is required' });
    }
    return new Promise(function(resolve) {
      chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError) {
          Logger.error('[TabGetTabGroup] Error: ' + chrome.runtime.lastError.message);
          resolve({ tabId: tabId, groupId: -1, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({
          tabId: tab.id,
          groupId: tab.groupId != null ? tab.groupId : -1,
          url: tab.url || '',
          openerTabId: tab.openerTabId || null
        });
      });
    });
  }

  function tabGetMuteStatus(context) {
    var state = _getState(context);
    var params = context.params;
    var cdpOnly = params && params.cdpOnly;
    var attachedTabIds = state.getAttachedTabIds();

    return new Promise(function(resolve) {
      chrome.tabs.query({}, function(tabs) {
        if (chrome.runtime.lastError) {
          resolve({ tabs: [] });
          return;
        }

        var result = tabs;
        if (cdpOnly) {
          result = tabs.filter(function(t) {
            return attachedTabIds.indexOf(t.id) !== -1;
          });
        }

        resolve({
          tabs: result.map(function(tab) {
            return {
              id: tab.id,
              url: tab.url || '',
              title: tab.title || '',
              muted: tab.mutedInfo ? tab.mutedInfo.muted : false,
              mutedReason: tab.mutedInfo ? (tab.mutedInfo.reason || '') : ''
            };
          })
        });
      });
    });
  }

  function getTargetInfos() {
    return chrome.debugger.getTargets().then(function(targets) {
      var promises = targets.map(function(target) {
        if (target.tabId) {
          return new Promise(function(resolve) {
            chrome.tabs.get(target.tabId, function(tab) {
              if (tab && tab.openerTabId) {
                var openerMatch = targets.find(function(t) {
                  return String(t.tabId) === String(tab.openerTabId);
                });
                if (openerMatch) {
                  target.openerId = openerMatch.id;
                }
              }
              resolve(mapToTargetInfo(target));
            });
          });
        } else {
          return Promise.resolve(mapToTargetInfo(target));
        }
      });
      return Promise.all(promises);
    });
  }

  function getTargetInfoById(targetId) {
    return chrome.debugger.getTargets().then(function(targets) {
      var match = targets.find(function(t) {
        return t.id === targetId || String(t.tabId) === String(targetId);
      });
      if (!match) return null;

      var tabId = match.tabId;
      if (tabId) {
        return new Promise(function(resolve) {
          chrome.tabs.get(tabId, function(tab) {
            if (tab && tab.openerTabId) {
              var openerMatch = targets.find(function(t) {
                return String(t.tabId) === String(tab.openerTabId);
              });
              if (openerMatch) {
                match.openerId = openerMatch.id;
              }
            }
            resolve(mapToTargetInfo(match));
          });
        });
      }

      return mapToTargetInfo(match);
    });
  }

  function getFallbackTargetId() {
    var entry = ConnectionManager.getPrimaryConnection();
    var state = entry ? entry.state : null;
    if (state) {
      var currentTabId = state.getCurrentTabId();
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
    var info = {
      targetId: target.id || String(target.tabId),
      type: target.type || 'page',
      title: target.title || '',
      url: target.url || '',
      attached: !!target.attached,
      canAccessOpener: false,
      browserContextId: 'default'
    };
    if (target.openerId) {
      info.openerId = target.openerId;
    }
    return info;
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
    mapToTargetInfo: mapToTargetInfo,
    tabGetMuteStatus: tabGetMuteStatus,
    tabGetGroupInfo: tabGetGroupInfo,
    tabUngroup: tabUngroup,
    tabSimulateUserOpen: tabSimulateUserOpen,
    tabGetTabGroup: tabGetTabGroup
  };
})();
