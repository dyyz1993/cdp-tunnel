var SpecialHandler = (function() {
  var _groupQueue = new Map();

  function muteTabIfNeeded(tabId) {
    Config.getAutoMute(function(enabled) {
      if (!enabled) return;
      chrome.tabs.update(tabId, { muted: true }, function() {
        if (chrome.runtime.lastError) {
          Logger.error('[TabMute] Failed to mute tab ' + tabId + ':', chrome.runtime.lastError.message);
        } else {
          Logger.info('[TabMute] Tab muted:', tabId);
        }
      });
    });
  }

  function targetSetAutoAttach(context) {
    var params = context.params;
    State.setAutoAttachConfig({
      autoAttach: !!(params && params.autoAttach),
      waitForDebuggerOnStart: !!(params && params.waitForDebuggerOnStart),
      flatten: !(params && params.flatten === false)
    });

    if (params && params.autoAttach) {
      return emitAutoAttachForExistingTargets(context).then(function() {
        return {};
      });
    }
    return Promise.resolve({});
  }

  function targetAttachToTarget(context) {
    var params = context.params;
    var targetId = params && params.targetId;
    var clientId = context.clientId;
    if (!targetId) {
      return Promise.resolve({});
    }

    return resolveTabId(targetId).then(function(tabId) {
      if (!tabId) {
        throw new Error('Target not found');
      }

      var isAlreadyAttached = State.isTabAttached(tabId);

      if (isAlreadyAttached) {
        var newSessionId = CDPUtils.generateSessionId();
        State.mapSession(newSessionId, tabId, targetId);
        muteTabIfNeeded(tabId);
        Logger.info('[CDP] Created additional session:', newSessionId, 'for tab:', tabId);
        return { sessionId: newSessionId };
      }

      return DebuggerManager.attach(tabId).then(function(attached) {
        if (!attached) {
          throw new Error('Failed to attach');
        }

        var sessionId = CDPUtils.generateSessionId();
        State.mapSession(sessionId, tabId, targetId);

        if (clientId) {
          State.setTabIdToClientId(tabId, clientId);
        }

        if (State.isCDPCreatedTab(tabId)) {
          addTabToAutomationGroup(tabId, clientId);
        } else {          State.addPreExistingTab(tabId);
          Logger.info('[CDP] Target.attachToTarget: user tab not CDP-created, treating as pre-existing. tabId:', tabId);
        }

        return { sessionId: sessionId };
      });
    });
  }

  function targetDetachFromTarget(context) {
    var params = context.params;
    var sessionId = params && params.sessionId;
    if (!sessionId) {
      return Promise.resolve({});
    }

    var tabId = State.getTabIdBySession(sessionId);
    State.unmapSession(sessionId);

    if (tabId && !State.hasOtherSessionForTab(tabId)) {
      return DebuggerManager.detach(tabId).then(function() {
        return {};
      }).catch(function() {
        return {};
      });
    }
    return Promise.resolve({});
  }

  function targetCreateTarget(context) {
    var params = context.params;
    var url = (params && params.url) || 'about:blank';
    var browserContextId = (params && params.browserContextId) || 'default';
    var clientId = context.clientId;
    var needsNavigate = url !== 'about:blank' && url !== '';

    return new Promise(function(resolve, reject) {
      // Step 1: 先创建 about:blank (不加载任何资源，tab bar 闪烁最小)
      chrome.tabs.create({ url: 'about:blank', active: false }, function(tab) {
        if (!tab || !tab.id) {
          reject(new Error('Failed to create tab'));
          return;
        }

        if (clientId) {
          State.setTabIdToClientId(tab.id, clientId);
        }

        State.addCDPCreatedTab(tab.id);

        // Step 2: 立刻分组折叠 (用户在 tab bar 上看不到)
        groupTabSilently(tab.id, clientId).then(function() {
          // Step 3: 获取 targetId 并 attach debugger
          return getTargetIdByTabId(tab.id).then(function(targetId) {
            return emitAutoAttachEvents(tab.id, targetId, browserContextId).then(function() {
              // Step 4: 折叠+attach 完成后，再导航到真实 URL
              if (needsNavigate) {
                State.addPendingCreatedTabUrl(url);
                return navigateTabQuietly(tab.id, url).then(function() {
                  resolve({ targetId: targetId });
                });
              }
              resolve({ targetId: targetId });
            });
          });
        }).catch(function(err) {
          Logger.error('[CreateTarget] Error:', err.message || err);
          reject(err);
        });
      });
    });
  }

  function groupTabSilently(tabId, clientId) {
    return new Promise(function(resolve) {
      addTabToAutomationGroup(tabId, clientId, function(success) {
        setTimeout(resolve, 50);
      });
    });
  }

  function navigateTabQuietly(tabId, url) {
    return new Promise(function(resolve) {
      chrome.tabs.update(tabId, { url: url }, function() {
        if (chrome.runtime.lastError) {
          Logger.warn('[NavigateQuietly] Failed:', chrome.runtime.lastError.message);
        }
        // 不管成功失败都 resolve，让调用者继续
        resolve();
      });
    });
  }

  function addTabToAutomationGroup(tabId, clientId, callback) {
    var key = clientId || '__no_client__';
    var prev = _groupQueue.get(key) || Promise.resolve();

    var next = prev.then(function() {
      return new Promise(function(resolve, reject) {
        var timeoutId = setTimeout(function() {
          reject(new Error('addTabToAutomationGroup timeout after 10s'));
        }, 10000);

        _addTabToAutomationGroupInner(tabId, clientId, function(success) {
          clearTimeout(timeoutId);
          resolve(success);
        });
      });
    }).catch(function(err) {
      Logger.error('[addTabToAutomationGroup] queue error:', err.message || err);
    });

    _groupQueue.set(key, next);

    next.finally(function() {
      if (_groupQueue.get(key) === next) {
        _groupQueue.delete(key);
      }
    });

    if (callback) {
      next.then(function(success) { callback(success); });
    }
  }

  function _addTabToAutomationGroupInner(tabId, clientId, callback) {
    Logger.info('[TabGroup] Starting addTabToAutomationGroup for tabId:', tabId, 'clientId:', clientId);

    WebSocketManager.send({ type: 'tabgroup-debug', tabId: tabId, clientId: clientId, phase: 'start' });

    setTimeout(function() {
      try {
        muteTabIfNeeded(tabId);
      } catch (e) {
        Logger.error('[TabGroup] muteTabIfNeeded threw:', e.message || e);
      }
    }, 200);

    var groupClientId = clientId;
    if (!groupClientId) {
      var cdpClients = State.getCDPClients() || [];
      if (cdpClients.length > 0 && cdpClients[0] && cdpClients[0].id) {
        groupClientId = cdpClients[0].id;
        Logger.warn('[TabGroup] No clientId for tab:', tabId, 'fallback to first client:', groupClientId);
      } else {
        Logger.warn('[TabGroup] No clientId for tab:', tabId, '— skipping group operation');
        if (callback) callback(false);
        return;
      }
    }
    var baseName = CDPUtils.getGroupBaseName(groupClientId);

    Logger.info('[TabGroup] Grouping tab immediately for:', baseName);
    doGroup(tabId, groupClientId, baseName, 0, callback);
  }

  function doGroup(tabId, clientId, baseName, retries, callback) {
    retries = retries || 0;
    Logger.info('[TabGroup] doGroup: tabId=' + tabId + ' clientId=' + (clientId || 'none') + ' baseName=' + baseName + ' retry=' + retries);
    if (!chrome.tabGroups) {
      Logger.warn('[TabGroup] chrome.tabGroups API not available (headless mode?), skipping grouping for tab:', tabId);
      EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'skip', reason: 'tabGroups-unavailable', tabId: tabId });
      if (callback) callback(false);
      return;
    }
    var cachedGroupId = State.getGroupIdForClient(clientId);
    if (cachedGroupId) {
      Logger.info('[TabGroup] Using cached groupId:', cachedGroupId, 'for client:', clientId);
      chrome.tabs.group({ tabIds: tabId, groupId: cachedGroupId }, function(result) {
        if (!chrome.runtime.lastError) {
          updateTabGroupName(clientId);
          Logger.info('[TabGroup] Tab', tabId, 'added to cached group:', cachedGroupId);
          if (callback) callback(true);
          return;
        }
        Logger.warn('[TabGroup] Cached groupId', cachedGroupId, 'failed:', chrome.runtime.lastError.message, '— falling back to query');
        doGroupQuery(tabId, clientId, baseName, retries, callback);
      });
      return;
    }
    doGroupQuery(tabId, clientId, baseName, retries, callback);
  }

  function doGroupQuery(tabId, clientId, baseName, retries, callback) {
    chrome.tabGroups.query({}, function(allGroups) {
      if (chrome.runtime.lastError) {
        Logger.error('[TabGroup] tabGroups.query failed:', chrome.runtime.lastError.message);
        EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'query', error: chrome.runtime.lastError.message });
      }
      if (!allGroups) {
        Logger.error('[TabGroup] tabGroups.query returned null');
        if (retries < 3) {
          setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1, callback); }, 500);
        } else {
          if (callback) callback(false);
        }
        return;
      }
      Logger.info('[TabGroup] query result: ' + allGroups.length + ' groups');
      var existing = CDPUtils.findGroupByName(allGroups, baseName);
      if (existing) {
        Logger.info('[TabGroup] Found existing group:', existing.id, 'title:', existing.title);
        chrome.tabs.group({ tabIds: tabId, groupId: existing.id }, function(result) {
          if (chrome.runtime.lastError) {
            Logger.error('[TabGroup] Failed to add tab to group:', chrome.runtime.lastError.message, 'retries:', retries);
            EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'addToExisting', error: chrome.runtime.lastError.message, tabId: tabId, groupId: existing.id });
            if (retries < 3) {
              setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1, callback); }, 500);
            } else {
              if (callback) callback(false);
            }
          } else {
            State.setGroupIdForClient(clientId, existing.id);
            updateTabGroupName(clientId);
            Logger.info('[TabGroup] Tab', tabId, 'added to existing group:', existing.id);
            if (callback) callback(true);
          }
        });
      } else {
        Logger.info('[TabGroup] No existing group, creating new one for tab:', tabId);
        chrome.tabs.group({ tabIds: tabId }, function(groupId) {
          if (chrome.runtime.lastError) {
            Logger.error('[TabGroup] Failed to create group:', chrome.runtime.lastError.message, 'retries:', retries);
            EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'createGroup', error: chrome.runtime.lastError.message, tabId: tabId });
            if (retries < 3) {
              setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1, callback); }, 500);
            } else {
              if (callback) callback(false);
            }
            return;
          }
          Logger.info('[TabGroup] chrome.tabs.group returned groupId:', groupId);
          EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'groupCreated', tabId: tabId, groupId: groupId });
          if (groupId) {
            if (chrome.tabGroups) {
              chrome.tabGroups.update(groupId, {
                title: baseName,
                color: CDPUtils.getGroupColorForClient(clientId),
                collapsed: true
              }, function() {
                if (chrome.runtime.lastError) {
                  Logger.error('[TabGroup] Failed to update group:', chrome.runtime.lastError.message);
                  EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'updateGroup', error: chrome.runtime.lastError.message, groupId: groupId });
                } else {
                  State.setGroupIdForClient(clientId, groupId);
                  updateTabGroupName(clientId);
                  Logger.info('[TabGroup] Group updated:', groupId, baseName);
                }
                if (callback) callback(true);
              });
            } else {
              State.setGroupIdForClient(clientId, groupId);
              Logger.info('[TabGroup] Group created but tabGroups.update unavailable (headless):', groupId);
              if (callback) callback(true);
            }
          } else {
            Logger.error('[TabGroup] chrome.tabs.group returned null groupId');
            if (callback) callback(false);
          }
        });
      }
    });
  }

  function updateTabGroupName(clientId) {
    if (!clientId) return;
    
    var groupId = State.getGroupIdForClient(clientId);
    if (!groupId) return;
    
    chrome.tabs.query({ groupId: groupId }, function(tabs) {
      if (chrome.runtime.lastError || !tabs) return;
      
      var baseName = CDPUtils.getGroupBaseName(clientId);
      var newName = baseName + ' (' + tabs.length + ')';
      
      chrome.tabGroups.update(groupId, {
        title: newName
      }, function() {
        if (chrome.runtime.lastError) {
          Logger.error('[TabGroup] Failed to update group name:', chrome.runtime.lastError.message);
        } else {
          Logger.info('[TabGroup] Updated group name:', newName);
        }
      });
    });
  }
  
  function targetActivateTarget(context) {
    var params = context.params;
    var targetId = params && params.targetId;
    if (targetId) {
      return new Promise(function(resolve) {
        chrome.tabs.update(parseInt(targetId, 10), { active: true }, function() {
          resolve({});
        });
      }).catch(function() {
        return {};
      });
    }
    return Promise.resolve({});
  }

  function targetCloseTarget(context) {
    var params = context.params;
    var targetId = params && params.targetId;
    if (targetId) {
      var tabId = State.getTabIdByTargetId(targetId);
      if (tabId) {
        var closeClientId = State.getClientIdByTabId(tabId);
        return new Promise(function(resolve) {
          chrome.tabs.remove(tabId, function() {
            State.removeAttachedTab(tabId);
            if (closeClientId) {
              updateTabGroupName(closeClientId);
            }
            resolve({ success: true });
          });
        }).catch(function() {
          State.removeAttachedTab(tabId);
          return { success: true };
        });
      }
    }
    return Promise.resolve({ success: true });
  }

  function pageStartScreencast(context) {
    var params = context.params;
    var sessionId = context.sessionId;
    var tabId = sessionId ? State.getTabIdBySession(sessionId) : State.getCurrentTabId();

    return checkTabVisibility(tabId).then(function(isVisible) {
      if (!isVisible) {
        return Screencast.startPolling(tabId, params, sessionId).then(function() {
          return {};
        });
      }
      return ForwardHandler.execute({ id: context.id, method: 'Page.startScreencast', params: params, sessionId: sessionId });
    });
  }

  function pageStopScreencast(context) {
    var sessionId = context.sessionId;
    var tabId = sessionId ? State.getTabIdBySession(sessionId) : State.getCurrentTabId();
    var session = tabId ? State.getScreencastSession(tabId) : null;
    
    if (session) {
      Screencast.stopPolling(tabId);
    }
    
    return {};
  }

  function pageScreencastFrameAck(context) {
    var params = context.params;
    var sessionId = context.sessionId;
    var tabId = sessionId ? State.getTabIdBySession(sessionId) : State.getCurrentTabId();
    var session = tabId ? State.getScreencastSession(tabId) : null;
    
    if (session) {
      Screencast.ackFrame(tabId, params && params.sessionId);
      return {};
    }
    
    return {};
  }

  function runtimeRunIfWaitingForDebugger(context) {
    var sessionId = context.sessionId;
    var tabId = sessionId ? State.getTabIdBySession(sessionId) : State.getCurrentTabId();

    if (tabId && State.isPendingDebuggerTab(tabId)) {
      State.removePendingDebuggerTab(tabId);
    }
    return {};
  }

  function resolveTabId(targetId) {
    if (/^\d+$/.test(targetId)) {
      return Promise.resolve(parseInt(targetId, 10));
    }

    return chrome.debugger.getTargets().then(function(targets) {
      var match = targets.find(function(t) { return t.id === targetId; });
      return match && match.tabId ? match.tabId : null;
    });
  }

  function getTargetIdByTabId(tabId) {
    return chrome.debugger.getTargets().then(function(targets) {
      var match = targets.find(function(t) { return t.tabId === tabId; });
      return match ? match.id : String(tabId);
    });
  }

function checkTabVisibility(tabId) {
  return new Promise(function(resolve) {
    chrome.tabs.get(tabId, function(tab) {
      if (chrome.runtime.lastError || !tab) {
        resolve(false);
        return;
      }
      chrome.windows.get(tab.windowId, function(win) {
        if (chrome.runtime.lastError || !win) {
          resolve(false);
          return;
        }
        resolve(tab.active && win.focused);
      });
    });
  }).catch(function() {
    return false;
  });
}

  function emitAutoAttachForExistingTargets(context) {
    var clientId = context ? context.clientId : null;
    var config = State.getAutoAttachConfig();

    return chrome.debugger.getTargets().then(function(targets) {
      var promises = [];

      Logger.info('[CDP] emitAutoAttachForExistingTargets: checking', targets.length, 'targets, clientId:', clientId);

      targets.forEach(function(target) {
        if (target.type !== 'page' && target.type !== 'background_page') return;
        if (!target.tabId) return;

        var targetId = target.id;
        var tabId = target.tabId;
        var hasEmitted = State.hasEmittedTarget(targetId);

        if (hasEmitted) {
          Logger.info('[CDP] Target already emitted, skipping:', targetId);
          return;
        }

        var isCDPCreated = State.isCDPCreatedTab(tabId);
        var isOwnedByClient = isCDPCreated && State.getClientIdByTabId(tabId) === clientId;
        var otherClientOwns = isCDPCreated && !isOwnedByClient;

        if (!isCDPCreated) {
          Logger.info('[CDP] Skipping non-CDP (user) tab:', targetId, 'tabId:', tabId);
          return;
        }

        if (otherClientOwns) {
          Logger.info('[CDP] Skipping other-client tab:', targetId, 'tabId:', tabId);
          State.addEmittedTarget(targetId);
          return;
        }

        State.addEmittedTarget(targetId);
        var targetInfo = LocalHandler.mapToTargetInfo(target);
        
        Logger.info('[CDP] Emitting CDP-owned target:', targetId, 'tabId:', tabId);

        var attachLogic = function(attached) {
          var sessionId = CDPUtils.generateSessionId();
          State.mapSession(sessionId, tabId, targetId);

          if (config.waitForDebuggerOnStart) {
            State.addPendingDebuggerTab(tabId);
          }

          EventBuilder.send('Target.attachedToTarget', {
            sessionId: sessionId,
            targetInfo: Object.assign({}, targetInfo, { attached: true }),
            waitingForDebugger: config.waitForDebuggerOnStart || false
          });
        };

        if (target.attached) {
          promises.push(Promise.resolve().then(function() { attachLogic(true); }));
        } else {
          promises.push(
            DebuggerManager.attach(tabId).then(function(attached) {
              if (!attached) return;
              attachLogic(attached);
            })
          );
        }
      });

      return Promise.all(promises);
    });
  }

  function emitAutoAttachEvents(tabId, targetId, browserContextId) {
    if (State.hasEmittedTarget(targetId)) {
      Logger.info('[CDP] Target already emitted, skipping emitAutoAttachEvents:', targetId);
      return Promise.resolve();
    }
    
    State.addEmittedTarget(targetId);

    return LocalHandler.getTargetInfoById(targetId).then(function(targetInfo) {
      if (browserContextId && browserContextId !== 'default') {
        targetInfo.browserContextId = browserContextId;
      }
      EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo });

      return DebuggerManager.attach(tabId).then(function(attached) {
        if (!attached) return;

        var sessionId = CDPUtils.generateSessionId();
        State.mapSession(sessionId, tabId, targetId);

        var config = State.getAutoAttachConfig();
        if (config.waitForDebuggerOnStart) {
          State.addPendingDebuggerTab(tabId);
        }

        EventBuilder.send('Target.attachedToTarget', {
          sessionId: sessionId,
          targetInfo: targetInfo,
          waitingForDebugger: config.waitForDebuggerOnStart
        });
      });
    });
  }

  function pageCreateIsolatedWorld(context) {
    var params = context.params;
    var sessionId = context.sessionId;
    var tabId = sessionId ? State.getTabIdBySession(sessionId) : State.getCurrentTabId();

    return ForwardHandler.execute({ id: context.id, method: 'Page.createIsolatedWorld', params: params, sessionId: sessionId });
  }

  function pageAddScriptToEvaluateOnNewDocument(context) {
    var params = context.params;
    var sessionId = context.sessionId;
    var tabId = sessionId ? State.getTabIdBySession(sessionId) : State.getCurrentTabId();

    return ForwardHandler.execute({ id: context.id, method: 'Page.addScriptToEvaluateOnNewDocument', params: params, sessionId: sessionId });
  }

  function domSetFileInputFiles(context) {
    var params = context.params;
    var sessionId = context.sessionId;
    var files = params && params.files;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return ForwardHandler.execute({ id: context.id, method: 'DOM.setFileInputFiles', params: params, sessionId: sessionId });
    }

    var hasUrl = files.some(function(f) {
      return typeof f === 'string' && (f.startsWith('http://') || f.startsWith('https://'));
    });

    if (!hasUrl) {
      return ForwardHandler.execute({ id: context.id, method: 'DOM.setFileInputFiles', params: params, sessionId: sessionId });
    }

    Logger.info('[CDP] DOM.setFileInputFiles: 检测到远程 URL, 开始下载...');

    return downloadRemoteFiles(files).then(function(localFiles) {
      Logger.info('[CDP] DOM.setFileInputFiles: 下载完成, 本地路径:', localFiles);
      
      var newParams = Object.assign({}, params, { files: localFiles });
      return ForwardHandler.execute({ id: context.id, method: 'DOM.setFileInputFiles', params: newParams, sessionId: sessionId });
    });
  }

  function downloadRemoteFiles(files) {
    var promises = files.map(function(file) {
      if (typeof file === 'string' && (file.startsWith('http://') || file.startsWith('https://'))) {
        return downloadRemoteFile(file);
      }
      return Promise.resolve(file);
    });

    return Promise.all(promises);
  }

  function downloadRemoteFile(url) {
    return new Promise(function(resolve, reject) {
      var filename = 'cdp_upload_' + Date.now() + '_' + url.split('/').pop().split('?')[0];
      
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: false
      }, function(downloadId) {
        if (chrome.runtime.lastError) {
          Logger.error('[CDP] 下载失败:', chrome.runtime.lastError.message);
          reject(new Error('Download failed: ' + chrome.runtime.lastError.message));
          return;
        }

        Logger.info('[CDP] 开始下载, downloadId:', downloadId);

        waitForDownloadComplete(downloadId).then(function() {
          return chrome.downloads.search({ id: downloadId });
        }).then(function(results) {
          if (results.length === 0) {
            reject(new Error('Download item not found'));
            return;
          }
          
          var filePath = results[0].filename;
          Logger.info('[CDP] 下载完成, 本地路径:', filePath);
          resolve(filePath);
        }).catch(reject);
      });
    });
  }

  function waitForDownloadComplete(downloadId) {
    return new Promise(function(resolve, reject) {
      var timeout = setTimeout(function() {
        reject(new Error('Download timeout after 60s'));
      }, 60000);

      function listener(delta) {
        if (delta.id !== downloadId) return;

        if (delta.state && delta.state.current === 'complete') {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (delta.state && delta.state.current === 'interrupted') {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error('Download interrupted: ' + (delta.error && delta.error.current)));
        }
      }

      chrome.downloads.onChanged.addListener(listener);
    });
  }

  return {
    targetSetAutoAttach: targetSetAutoAttach,
    targetAttachToTarget: targetAttachToTarget,
    targetDetachFromTarget: targetDetachFromTarget,
    targetCreateTarget: targetCreateTarget,
    targetActivateTarget: targetActivateTarget,
    targetCloseTarget: targetCloseTarget,
    pageStartScreencast: pageStartScreencast,
    pageStopScreencast: pageStopScreencast,
    pageScreencastFrameAck: pageScreencastFrameAck,
    pageCreateIsolatedWorld: pageCreateIsolatedWorld,
    pageAddScriptToEvaluateOnNewDocument: pageAddScriptToEvaluateOnNewDocument,
    runtimeRunIfWaitingForDebugger: runtimeRunIfWaitingForDebugger,
    domSetFileInputFiles: domSetFileInputFiles,
    updateTabGroupName: updateTabGroupName,
    addTabToAutomationGroup: addTabToAutomationGroup
  };
})();
