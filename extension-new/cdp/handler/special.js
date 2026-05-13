var SpecialHandler = (function() {
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
        } else {
          State.addPreExistingTab(tabId);
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

    return new Promise(function(resolve, reject) {
      State.addPendingCreatedTabUrl(url);
      // 默认设置active: false，避免自动切换标签页
      chrome.tabs.create({ url: url, active: false }, function(tab) {
        if (!tab || !tab.id) {
          State.removePendingCreatedTabUrl(url);
          reject(new Error('Failed to create tab'));
          return;
        }

        // 保存tabId到clientId的映射，用于后续分组
        if (clientId) {
          State.setTabIdToClientId(tab.id, clientId);
        }

        State.addCDPCreatedTab(tab.id);

        addTabToAutomationGroup(tab.id, clientId);

        getTargetIdByTabId(tab.id).then(function(targetId) {
          return emitAutoAttachEvents(tab.id, targetId, browserContextId).then(function() {
            resolve({ targetId: targetId });
          });
        });
      });
    });
  }

  function addTabToAutomationGroup(tabId, clientId) {
    Logger.info('[TabGroup] Starting addTabToAutomationGroup for tabId:', tabId, 'clientId:', clientId);

    setTimeout(function() {
      muteTabIfNeeded(tabId);
    }, 200);

    var groupClientId = clientId;
    if (!groupClientId) {
      var cdpClients = State.getCDPClients() || [];
      if (cdpClients.length > 0 && cdpClients[0] && cdpClients[0].id) {
        groupClientId = cdpClients[0].id;
        Logger.warn('[TabGroup] No clientId for tab:', tabId, 'fallback to first client:', groupClientId);
      } else {
        Logger.warn('[TabGroup] No clientId for tab:', tabId, '— skipping group operation');
        return;
      }
    }
    var baseName = CDPUtils.getGroupBaseName(groupClientId);

    Logger.info('[TabGroup] Grouping tab immediately for:', baseName);
    doGroup(tabId, groupClientId, baseName);
  }

  function doGroup(tabId, clientId, baseName, retries) {
    retries = retries || 0;
    chrome.tabGroups.query({}, function(allGroups) {
      var existing = CDPUtils.findGroupByName(allGroups, baseName);
      if (existing) {
        chrome.tabs.group({ tabIds: tabId, groupId: existing.id }, function(result) {
          if (chrome.runtime.lastError) {
            Logger.error('[TabGroup] Failed to add tab to group:', chrome.runtime.lastError.message, 'retries:', retries);
            if (retries < 3) {
              setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1); }, 500);
            }
          } else {
            State.setGroupIdForClient(clientId, existing.id);
            updateTabGroupName(clientId);
            Logger.info('[TabGroup] Tab', tabId, 'added to existing group:', existing.id);
          }
        });
      } else {
        chrome.tabs.group({ tabIds: tabId }, function(groupId) {
          if (chrome.runtime.lastError) {
            Logger.error('[TabGroup] Failed to create group:', chrome.runtime.lastError.message, 'retries:', retries);
            if (retries < 3) {
              setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1); }, 500);
            }
            return;
          }
          if (groupId) {
            chrome.tabGroups.update(groupId, {
              title: baseName,
              color: CDPUtils.getGroupColorForClient(clientId),
              collapsed: true
            }, function() {
              if (chrome.runtime.lastError) {
                Logger.error('[TabGroup] Failed to update group:', chrome.runtime.lastError.message);
              } else {
                State.setGroupIdForClient(clientId, groupId);
                updateTabGroupName(clientId);
                Logger.info('[TabGroup] Created new group:', groupId, 'with tab:', tabId);
              }
            });
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

        if (!isOwnedByClient) {
          Logger.info('[CDP] Skipping user/other-client tab:', targetId, 'tabId:', tabId, 'cdpCreated:', isCDPCreated);
          State.addEmittedTarget(targetId);
          return;
        }

        State.addEmittedTarget(targetId);
        var targetInfo = LocalHandler.mapToTargetInfo(target);
        
        Logger.info('[CDP] Emitting CDP-owned target:', targetId, 'tabId:', tabId);
        
        EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo });

        if (target.attached) {
          promises.push(Promise.resolve().then(function() {
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
          }));
        } else {
          promises.push(
            DebuggerManager.attach(tabId).then(function(attached) {
              if (!attached) return;
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
