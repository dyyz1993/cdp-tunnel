var SpecialHandler = (function() {
  function targetSetAutoAttach(context) {
    var params = context.params;
    State.setAutoAttachConfig({
      autoAttach: !!(params && params.autoAttach),
      waitForDebuggerOnStart: !!(params && params.waitForDebuggerOnStart),
      flatten: !(params && params.flatten === false)
    });

    if (params && params.autoAttach) {
      return emitAutoAttachForExistingTargets().then(function() {
        return {};
      });
    }
    return Promise.resolve({});
  }

  function targetAttachToTarget(context) {
    var params = context.params;
    var targetId = params && params.targetId;
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
        Logger.info('[CDP] Created additional session:', newSessionId, 'for tab:', tabId);
        return { sessionId: newSessionId };
      }

      return DebuggerManager.attach(tabId).then(function(attached) {
        if (!attached) {
          throw new Error('Failed to attach');
        }

        var sessionId = CDPUtils.generateSessionId();
        State.mapSession(sessionId, tabId, targetId);
        
        addTabToAutomationGroup(tabId);
        
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

    return new Promise(function(resolve, reject) {
      State.addPendingCreatedTabUrl(url);
      // 默认设置active: false，避免自动切换标签页
      chrome.tabs.create({ url: url, active: false }, function(tab) {
        if (!tab || !tab.id) {
          State.removePendingCreatedTabUrl(url);
          reject(new Error('Failed to create tab'));
          return;
        }
        
        // 将标签页添加到CDP Automation组
        addTabToAutomationGroup(tab.id);
        
        var targetId = String(tab.id);
        State.addEmittedTarget(targetId);
        getTargetIdByTabId(tab.id).then(function(targetId) {
          return emitAutoAttachEvents(tab.id, targetId, browserContextId).then(function() {
            resolve({ targetId: targetId });
          });
        });
      });
    });
  }
  
  function addTabToAutomationGroup(tabId) {
    Logger.info('[TabGroup] Starting addTabToAutomationGroup for tabId:', tabId);
    
    // 获取当前CDP客户端列表
    var cdpClients = State.getCDPClients() || [];
    var groupName;
    
    // 如果有CDP客户端，使用第一个客户端的ID作为组名
    if (cdpClients.length > 0) {
      groupName = 'CDP-' + cdpClients[0].id.substring(0, 8);
      Logger.info('[TabGroup] Using CDP client ID for group name:', groupName);
    } else {
      // 如果没有CDP客户端，使用固定的组名
      groupName = 'CDP-Automation';
      Logger.info('[TabGroup] No CDP client, using default group name:', groupName);
    }
    
    // 添加延迟等待，确保标签页完全加载后再分组
    setTimeout(function() {
      Logger.info('[TabGroup] Executing group operation after delay...');
      
      // 查找或创建标签组
      chrome.tabGroups.query({ title: groupName }, function(groups) {
        Logger.info('[TabGroup] Found groups:', groups);
        
        if (groups.length > 0) {
          // 找到现有的组，将标签页添加到组
          Logger.info('[TabGroup] Adding tab to existing group:', groups[0].id);
          chrome.tabs.group({ tabIds: tabId, groupId: groups[0].id }, function(groupId) {
            if (chrome.runtime.lastError) {
              Logger.error('[TabGroup] Failed to add tab to group:', chrome.runtime.lastError.message);
            } else {
              Logger.info('[TabGroup] Tab added to group:', groupId, 'Group name:', groupName);
            }
          });
        } else {
          // 创建新组并添加标签页
          Logger.info('[TabGroup] Creating new group...');
          chrome.tabs.group({ tabIds: tabId }, function(groupId) {
            if (chrome.runtime.lastError) {
              Logger.error('[TabGroup] Failed to create group:', chrome.runtime.lastError.message);
              return;
            }
            // 更新组的标题和颜色
            if (groupId) {
              Logger.info('[TabGroup] Group created with ID:', groupId);
              // 为不同的组使用不同的颜色
              var colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
              var colorIndex = Math.abs(groupName.hashCode ? groupName.hashCode() : 0) % colors.length;
              var groupColor = colors[colorIndex];
              
              Logger.info('[TabGroup] Updating group with title:', groupName, 'color:', groupColor);
              chrome.tabGroups.update(groupId, {
                title: groupName,
                color: groupColor
              }, function(group) {
                if (chrome.runtime.lastError) {
                  Logger.error('[TabGroup] Failed to update group:', chrome.runtime.lastError.message);
                } else {
                  Logger.info('[TabGroup] Group created and updated:', group);
                }
              });
            }
          });
        }
      });
    }, 2000); // 等待2秒
  }
  
  // 为字符串添加hashCode方法（用于生成颜色索引）
  String.prototype.hashCode = function() {
    var hash = 0;
    for (var i = 0; i < this.length; i++) {
      var char = this.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  };

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
        return new Promise(function(resolve) {
          chrome.tabs.remove(tabId, function() {
            resolve({ success: true });
          });
        }).catch(function() {
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

  function emitAutoAttachForExistingTargets() {
    return chrome.debugger.getTargets().then(function(targets) {
      var config = State.getAutoAttachConfig();
      var promises = [];

      Logger.info('[CDP] emitAutoAttachForExistingTargets: checking', targets.length, 'targets');
      Logger.info('[CDP] Current attachedTabIds:', State.getAttachedTabIds());

      targets.forEach(function(target) {
        if (target.type !== 'page' && target.type !== 'background_page') return;
        if (!target.tabId) return;

        var targetId = target.id;
        var hasEmitted = State.hasEmittedTarget(targetId);
        Logger.info('[CDP] emitAutoAttachForExistingTargets: targetId=', targetId, 'tabId=', target.tabId, 'attached=', target.attached, 'hasEmitted=', hasEmitted);

        if (hasEmitted) {
          Logger.info('[CDP] Target already emitted in emitAutoAttachForExistingTargets, skipping:', targetId);
          return;
        }
        State.addEmittedTarget(targetId);

        var isAttachedByUs = State.isTabAttached(target.tabId);
        var targetInfo = LocalHandler.mapToTargetInfo(target);
        
        Logger.info('[CDP] isAttachedByUs=', isAttachedByUs, 'for tabId=', target.tabId);
        
        if (target.attached && !isAttachedByUs) {
          targetInfo.attached = false;
          Logger.info('[CDP] Target attached by another debugger, reporting as not attached:', targetId, 'tabId:', target.tabId);
        }
        
        EventBuilder.send('Target.targetCreated', { targetInfo: targetInfo });

        if (target.attached && isAttachedByUs) {
          var promise = Promise.resolve();

          promises.push(promise.then(function() {
            var sessionId = CDPUtils.generateSessionId();
            State.mapSession(sessionId, target.tabId, targetId);

            addTabToAutomationGroup(target.tabId);

            if (config.waitForDebuggerOnStart) {
              State.addPendingDebuggerTab(target.tabId);
            }

            EventBuilder.send('Target.attachedToTarget', {
              sessionId: sessionId,
              targetInfo: Object.assign({}, targetInfo, { attached: true }),
              waitingForDebugger: config.waitForDebuggerOnStart
            });
          }));
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

        addTabToAutomationGroup(tabId);

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
    domSetFileInputFiles: domSetFileInputFiles
  };
})();
