var SpecialHandler = (function() {
  var _groupQueue = new Map();

  function _getState(ctx) {
    return ctx._state;
  }

  function _getWSManager(ctx) {
    return ctx._wsManager;
  }

  function _getConnectionTag(ctx) {
    var wm = ctx._wsManager;
    return (wm && wm.config && wm.config.tag) || null;
  }

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
    var state = _getState(context);
    var params = context.params;
    state.setAutoAttachConfig({
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
    var state = _getState(context);
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

      var isAlreadyAttached = state.isTabAttached(tabId);

      if (isAlreadyAttached) {
        var newSessionId = CDPUtils.generateSessionId();
        state.mapSession(newSessionId, tabId, targetId);
        muteTabIfNeeded(tabId);
        Logger.info('[CDP] Created additional session:', newSessionId, 'for tab:', tabId);
        return { sessionId: newSessionId };
      }

      return DebuggerManager.attach(tabId, state).then(function(attached) {
        if (!attached) {
          throw new Error('Failed to attach');
        }

        var sessionId = CDPUtils.generateSessionId();
        state.mapSession(sessionId, tabId, targetId);

        if (clientId) {
          state.setTabIdToClientId(tabId, clientId);
        }

        if (state.isCDPCreatedTab(tabId)) {
          addTabToAutomationGroup(tabId, clientId, null, context);
        } else if (context.mode === 'takeover') {
          state.addPreExistingTab(tabId);
          Logger.info('[CDP TAKEOVER] Target.attachToTarget: attached without grouping. tabId:', tabId);
        } else {
          state.addPreExistingTab(tabId);
          Logger.info('[CDP] Target.attachToTarget: user tab not CDP-created, treating as pre-existing. tabId:', tabId);
        }

        return { sessionId: sessionId };
      });
    });
  }

  function targetDetachFromTarget(context) {
    var state = _getState(context);
    var params = context.params;
    var sessionId = params && params.sessionId;
    if (!sessionId) {
      return Promise.resolve({});
    }

    var tabId = state.getTabIdBySession(sessionId);
    state.unmapSession(sessionId);

    if (tabId && !state.hasOtherSessionForTab(tabId)) {
      return DebuggerManager.detach(tabId, state).then(function() {
        return {};
      }).catch(function() {
        return {};
      });
    }
    return Promise.resolve({});
  }

  function targetCreateTarget(context) {
    var state = _getState(context);
    var wsManager = _getWSManager(context);
    var params = context.params;
    var url = (params && params.url) || 'about:blank';
    var browserContextId = (params && params.browserContextId) || 'default';
    var clientId = context.clientId;
    var needsNavigate = url !== 'about:blank' && url !== '';

    return new Promise(function(resolve, reject) {
      chrome.tabs.create({ url: 'about:blank', active: false }, function(tab) {
        if (!tab || !tab.id) {
          reject(new Error('Failed to create tab'));
          return;
        }

        if (clientId) {
          state.setTabIdToClientId(tab.id, clientId);
        }

        state.addCDPCreatedTab(tab.id);

        groupTabSilently(tab.id, clientId, context).then(function() {
          return getTargetIdByTabId(tab.id).then(function(targetId) {
            return emitAutoAttachEvents(tab.id, targetId, browserContextId, context).then(function() {
              if (needsNavigate) {
                state.addPendingCreatedTabUrl(url);
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

  function groupTabSilently(tabId, clientId, context) {
    return new Promise(function(resolve) {
      addTabToAutomationGroup(tabId, clientId, function(success) {
        setTimeout(resolve, 50);
      }, context);
    });
  }

  function navigateTabQuietly(tabId, url) {
    return new Promise(function(resolve) {
      chrome.tabs.update(tabId, { url: url }, function() {
        if (chrome.runtime.lastError) {
          Logger.warn('[NavigateQuietly] Failed:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    });
  }

  function addTabToAutomationGroup(tabId, clientId, callback, context) {
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
        }, context);
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

  function _addTabToAutomationGroupInner(tabId, clientId, callback, context) {
    var state = context ? _getState(context) : null;
    var wsManager = context ? _getWSManager(context) : null;
    var mode = context ? (context.mode || (state ? state.mode : null)) : null;

    if (mode === 'takeover') {
      Logger.info('[TabGroup] Skipping group for takeover tab:', tabId);
      if (callback) callback(false);
      return;
    }

    Logger.info('[TabGroup] Starting addTabToAutomationGroup for tabId:', tabId, 'clientId:', clientId);

    if (wsManager) {
      wsManager.send({ type: 'tabgroup-debug', tabId: tabId, clientId: clientId, phase: 'start' });
    }

    setTimeout(function() {
      try {
        muteTabIfNeeded(tabId);
      } catch (e) {
        Logger.error('[TabGroup] muteTabIfNeeded threw:', e.message || e);
      }
    }, 200);

    var groupClientId = clientId;
    if (!groupClientId) {
      var cdpClients = state ? state.getCDPClients() : [];
      if (cdpClients.length > 0 && cdpClients[0] && cdpClients[0].id) {
        groupClientId = cdpClients[0].id;
        Logger.warn('[TabGroup] No clientId for tab:', tabId, 'fallback to first client:', groupClientId);
      } else {
        Logger.warn('[TabGroup] No clientId for tab:', tabId, '— skipping group operation');
        if (callback) callback(false);
        return;
      }
    }
    var baseName = CDPUtils.getGroupBaseName(groupClientId, _getConnectionTag(context), context ? context.mode : null);

    Logger.info('[TabGroup] Grouping tab immediately for:', baseName);
    doGroup(tabId, groupClientId, baseName, 0, callback, context);
  }

  function doGroup(tabId, clientId, baseName, retries, callback, context) {
    var state = context ? _getState(context) : null;
    var wsManager = context ? _getWSManager(context) : null;
    retries = retries || 0;
    Logger.info('[TabGroup] doGroup: tabId=' + tabId + ' clientId=' + (clientId || 'none') + ' baseName=' + baseName + ' retry=' + retries);
    if (!chrome.tabGroups) {
      Logger.warn('[TabGroup] chrome.tabGroups API not available (headless mode?), skipping grouping for tab:', tabId);
      EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'skip', reason: 'tabGroups-unavailable', tabId: tabId }, null, wsManager);
      if (callback) callback(false);
      return;
    }
    var cachedGroupId = state ? state.getGroupIdForClient(clientId) : null;
    if (cachedGroupId) {
      Logger.info('[TabGroup] Using cached groupId:', cachedGroupId, 'for client:', clientId);
      chrome.tabs.group({ tabIds: tabId, groupId: cachedGroupId }, function(result) {
        if (!chrome.runtime.lastError) {
          updateTabGroupName(clientId, state, wsManager, context ? context.mode : null);
          Logger.info('[TabGroup] Tab', tabId, 'added to cached group:', cachedGroupId);
          if (callback) callback(true);
          return;
        }
        Logger.warn('[TabGroup] Cached groupId', cachedGroupId, 'failed:', chrome.runtime.lastError.message, '— falling back to query');
        doGroupQuery(tabId, clientId, baseName, retries, callback, context);
      });
      return;
    }
    doGroupQuery(tabId, clientId, baseName, retries, callback, context);
  }

  function doGroupQuery(tabId, clientId, baseName, retries, callback, context) {
    var state = context ? _getState(context) : null;
    var wsManager = context ? _getWSManager(context) : null;
    chrome.tabGroups.query({}, function(allGroups) {
      if (chrome.runtime.lastError) {
        Logger.error('[TabGroup] tabGroups.query failed:', chrome.runtime.lastError.message);
        EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'query', error: chrome.runtime.lastError.message }, null, wsManager);
      }
      if (!allGroups) {
        Logger.error('[TabGroup] tabGroups.query returned null');
        if (retries < 3) {
          setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1, callback, context); }, 500);
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
            EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'addToExisting', error: chrome.runtime.lastError.message, tabId: tabId, groupId: existing.id }, null, wsManager);
            if (retries < 3) {
              setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1, callback, context); }, 500);
            } else {
              if (callback) callback(false);
            }
          } else {
            if (state) state.setGroupIdForClient(clientId, existing.id);
            updateTabGroupName(clientId, state, wsManager, context ? context.mode : null);
            Logger.info('[TabGroup] Tab', tabId, 'added to existing group:', existing.id);
            if (callback) callback(true);
          }
        });
      } else {
        Logger.info('[TabGroup] No existing group, creating new one for tab:', tabId);
        chrome.tabs.group({ tabIds: tabId }, function(groupId) {
          if (chrome.runtime.lastError) {
            Logger.error('[TabGroup] Failed to create group:', chrome.runtime.lastError.message, 'retries:', retries);
            EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'createGroup', error: chrome.runtime.lastError.message, tabId: tabId }, null, wsManager);
            if (retries < 3) {
              setTimeout(function() { doGroup(tabId, clientId, baseName, retries + 1, callback, context); }, 500);
            } else {
              if (callback) callback(false);
            }
            return;
          }
          Logger.info('[TabGroup] chrome.tabs.group returned groupId:', groupId);
          EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'groupCreated', tabId: tabId, groupId: groupId }, null, wsManager);
          if (groupId) {
            if (chrome.tabGroups) {
              chrome.tabGroups.update(groupId, {
                title: baseName,
                color: CDPUtils.getGroupColorForClient(clientId),
                collapsed: true
              }, function() {
                if (chrome.runtime.lastError) {
                  Logger.error('[TabGroup] Failed to update group:', chrome.runtime.lastError.message);
                  EventBuilder.send('CDPTunnel.debug', { source: 'doGroup', phase: 'updateGroup', error: chrome.runtime.lastError.message, groupId: groupId }, null, wsManager);
                } else {
                  if (state) state.setGroupIdForClient(clientId, groupId);
                  updateTabGroupName(clientId, state, wsManager, context ? context.mode : null);
                  Logger.info('[TabGroup] Group updated:', groupId, baseName);
                }
                if (callback) callback(true);
              });
            } else {
              if (state) state.setGroupIdForClient(clientId, groupId);
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

  function updateTabGroupName(clientId, state, wsManager, mode) {
    if (!clientId) return;

    var groupId = state ? state.getGroupIdForClient(clientId) : null;
    if (!groupId) return;

    var connectionTag = (wsManager && wsManager.config && wsManager.config.tag) || null;

    chrome.tabs.query({ groupId: groupId }, function(tabs) {
      if (chrome.runtime.lastError || !tabs) return;

      var baseName = CDPUtils.getGroupBaseName(clientId, connectionTag, mode);
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
    var state = _getState(context);
    var params = context.params;
    var targetId = params && params.targetId;
    if (targetId) {
      var tabId = state.getTabIdByTargetId(targetId);
      if (tabId) {
        var closeClientId = state.getClientIdByTabId(tabId);
        return new Promise(function(resolve) {
          chrome.tabs.remove(tabId, function() {
            state.removeAttachedTab(tabId);
            if (closeClientId) {
              updateTabGroupName(closeClientId, state, _getWSManager(context), context ? context.mode : null);
            }
            resolve({ success: true });
          });
        }).catch(function() {
          state.removeAttachedTab(tabId);
          return { success: true };
        });
      }
    }
    return Promise.resolve({ success: true });
  }

  function pageStartScreencast(context) {
    var state = _getState(context);
    var params = context.params;
    var sessionId = context.sessionId;
    var tabId = sessionId ? state.getTabIdBySession(sessionId) : state.getCurrentTabId();

    return checkTabVisibility(tabId).then(function(isVisible) {
      if (!isVisible) {
        return Screencast.startPolling(tabId, params, sessionId, state).then(function() {
          return {};
        });
      }
      return ForwardHandler.execute(context);
    });
  }

  function pageStopScreencast(context) {
    var state = _getState(context);
    var sessionId = context.sessionId;
    var tabId = sessionId ? state.getTabIdBySession(sessionId) : state.getCurrentTabId();
    var session = tabId ? state.getScreencastSession(tabId) : null;

    if (session) {
      Screencast.stopPolling(tabId, state);
    }

    return {};
  }

  function pageScreencastFrameAck(context) {
    var state = _getState(context);
    var sessionId = context.sessionId;
    var tabId = sessionId ? state.getTabIdBySession(sessionId) : state.getCurrentTabId();
    var session = tabId ? state.getScreencastSession(tabId) : null;

    if (session) {
      Screencast.ackFrame(tabId, (context.params && context.params.sessionId), state);
      return {};
    }

    return {};
  }

  function runtimeRunIfWaitingForDebugger(context) {
    var state = _getState(context);
    var sessionId = context.sessionId;
    var tabId = sessionId ? state.getTabIdBySession(sessionId) : state.getCurrentTabId();

    if (tabId && state.isPendingDebuggerTab(tabId)) {
      state.removePendingDebuggerTab(tabId);
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
    var state = _getState(context);
    var wsManager = _getWSManager(context);
    var clientId = context ? context.clientId : null;
    var mode = context ? context.mode : null;
    var config = state.getAutoAttachConfig();

    return chrome.debugger.getTargets().then(function(targets) {
      var promises = [];

      Logger.info('[CDP] emitAutoAttachForExistingTargets: checking', targets.length, 'targets, clientId:', clientId, 'mode:', mode);

      if (mode === 'takeover') {
        var takeoverPromises = [];
        targets.forEach(function(target) {
          if (target.type !== 'page' || !target.tabId) return;
          var targetId = target.id;
          var tabId = target.tabId;
          if (state.hasEmittedTarget(targetId)) return;

          takeoverPromises.push(new Promise(function(resolve) {
            chrome.tabs.get(tabId, function(tab) {
              if (chrome.runtime.lastError || !tab) { resolve(); return; }
              var isGrouped = tab.groupId != null && tab.groupId !== -1;
              var isCDPCreated = state.isCDPCreatedTab(tabId);
              if (isGrouped || isCDPCreated) { resolve(); return; }

              state.addEmittedTarget(targetId);
              state.addPreExistingTab(tabId);
              if (clientId) state.setTabIdToClientId(tabId, clientId);
              var targetInfo = LocalHandler.mapToTargetInfo(target);
              Logger.info('[CDP TAKEOVER] Emitting ungrouped target:', targetId, 'tabId:', tabId);

              var attachLogic = function(attached) {
                var sessionId = CDPUtils.generateSessionId();
                state.mapSession(sessionId, tabId, targetId);
                EventBuilder.send('Target.attachedToTarget', {
                  sessionId: sessionId,
                  targetInfo: Object.assign({}, targetInfo, { attached: true }),
                  waitingForDebugger: false
                }, null, wsManager);
              };

              if (target.attached) {
                attachLogic(true);
                resolve();
              } else {
                DebuggerManager.attach(tabId, state).then(function(attached) {
                  if (!attached) { resolve(); return; }
                  attachLogic(attached);
                  resolve();
                }).catch(resolve);
              }
            });
          }));
        });
        return Promise.all(takeoverPromises);
      }

      targets.forEach(function(target) {
        if (target.type !== 'page' && target.type !== 'background_page') return;
        if (!target.tabId) return;

        var targetId = target.id;
        var tabId = target.tabId;
        var hasEmitted = state.hasEmittedTarget(targetId);

        if (hasEmitted) {
          Logger.info('[CDP] Target already emitted, skipping:', targetId);
          return;
        }

        var isCDPCreated = state.isCDPCreatedTab(tabId);
        var isOwnedByClient = isCDPCreated && state.getClientIdByTabId(tabId) === clientId;
        var otherClientOwns = isCDPCreated && !isOwnedByClient;

        if (!isCDPCreated) {
          Logger.info('[CDP] Skipping non-CDP (user) tab:', targetId, 'tabId:', tabId);
          return;
        }

        if (otherClientOwns) {
          Logger.info('[CDP] Skipping other-client tab:', targetId, 'tabId:', tabId);
          state.addEmittedTarget(targetId);
          return;
        }

        state.addEmittedTarget(targetId);
        var targetInfo = LocalHandler.mapToTargetInfo(target);

        Logger.info('[CDP] Emitting CDP-owned target:', targetId, 'tabId:', tabId);

        var attachLogic = function(attached) {
          var sessionId = CDPUtils.generateSessionId();
          state.mapSession(sessionId, tabId, targetId);

          if (config.waitForDebuggerOnStart) {
            state.addPendingDebuggerTab(tabId);
          }

          EventBuilder.send('Target.attachedToTarget', {
            sessionId: sessionId,
            targetInfo: Object.assign({}, targetInfo, { attached: true }),
            waitingForDebugger: config.waitForDebuggerOnStart || false
          }, null, wsManager);
        };

        if (target.attached) {
          promises.push(Promise.resolve().then(function() { attachLogic(true); }));
        } else {
          promises.push(
            DebuggerManager.attach(tabId, state).then(function(attached) {
              if (!attached) return;
              attachLogic(attached);
            })
          );
        }
      });

      return Promise.all(promises);
    });
  }

  function emitAutoAttachEvents(tabId, targetId, browserContextId, context) {
    var state = _getState(context);
    var wsManager = _getWSManager(context);
    if (state.hasEmittedTarget(targetId)) {
      Logger.info('[CDP] Target already emitted, skipping emitAutoAttachEvents:', targetId);
      return Promise.resolve();
    }

    state.addEmittedTarget(targetId);

    return LocalHandler.getTargetInfoById(targetId).then(function(targetInfo) {
      if (browserContextId && browserContextId !== 'default') {
        targetInfo.browserContextId = browserContextId;
      }
      EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo }, null, wsManager);

      return DebuggerManager.attach(tabId, state).then(function(attached) {
        if (!attached) return;

        var sessionId = CDPUtils.generateSessionId();
        state.mapSession(sessionId, tabId, targetId);

        var config = state.getAutoAttachConfig();
        if (config.waitForDebuggerOnStart) {
          state.addPendingDebuggerTab(tabId);
        }

        EventBuilder.send('Target.attachedToTarget', {
          sessionId: sessionId,
          targetInfo: targetInfo,
          waitingForDebugger: config.waitForDebuggerOnStart
        }, null, wsManager);
      });
    });
  }

  function pageCreateIsolatedWorld(context) {
    return ForwardHandler.execute(context);
  }

  function pageAddScriptToEvaluateOnNewDocument(context) {
    return ForwardHandler.execute(context);
  }

  function domSetFileInputFiles(context) {
    var params = context.params;
    var sessionId = context.sessionId;
    var files = params && params.files;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return ForwardHandler.execute(context);
    }

    var hasUrl = files.some(function(f) {
      return typeof f === 'string' && (f.startsWith('http://') || f.startsWith('https://'));
    });

    if (!hasUrl) {
      return ForwardHandler.execute(context);
    }

    Logger.info('[CDP] DOM.setFileInputFiles: 检测到远程 URL, 开始下载...');

    return downloadRemoteFiles(files).then(function(localFiles) {
      Logger.info('[CDP] DOM.setFileInputFiles: 下载完成, 本地路径:', localFiles);

      var newParams = Object.assign({}, params, { files: localFiles });
      var newContext = Object.assign({}, context, { params: newParams });
      return ForwardHandler.execute(newContext);
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
