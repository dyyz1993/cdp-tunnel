var CDP_HANDLERS = {
  'Browser.getVersion': { type: 'LOCAL', handler: LocalHandler.browserGetVersion },
  'Browser.setDownloadBehavior': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.close': { type: 'LOCAL', handler: LocalHandler.browserClose },
  'Browser.crash': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.crashGpuProcess': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.getWindowForTarget': { type: 'LOCAL', handler: LocalHandler.getWindowForTarget },
	'Browser.setWindowBounds': { type: 'LOCAL', handler: LocalHandler.setWindowBounds },
  'Browser.getWindowBounds': { type: 'LOCAL', handler: LocalHandler.getWindowBounds },
  'Browser.getBrowserCommandLine': { type: 'LOCAL', handler: LocalHandler.emptyArray },
  'Browser.getHistograms': { type: 'LOCAL', handler: LocalHandler.emptyArray },
  'Browser.getHistogram': { type: 'LOCAL', handler: LocalHandler.emptyObject },
  'Browser.grantPermissions': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.resetPermissions': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.setPermission': { type: 'LOCAL', handler: LocalHandler.emptyResult },

  'Target.setDiscoverTargets': { type: 'LOCAL', handler: LocalHandler.targetSetDiscoverTargets },
  'Target.getTargets': { type: 'LOCAL', handler: LocalHandler.targetGetTargets },
  'Target.getTargetInfo': { type: 'LOCAL', handler: LocalHandler.targetGetTargetInfo },
  'Target.createBrowserContext': { type: 'LOCAL', handler: LocalHandler.targetCreateBrowserContext },
  'Target.disposeBrowserContext': { type: 'LOCAL', handler: LocalHandler.targetDisposeBrowserContext },
  'Target.getBrowserContexts': { type: 'LOCAL', handler: LocalHandler.targetGetBrowserContexts },
  'Target.attachToBrowserTarget': { type: 'LOCAL', handler: LocalHandler.targetAttachToBrowserTarget },

  'Tab.getMuteStatus': { type: 'LOCAL', handler: LocalHandler.tabGetMuteStatus },
  'Tab.getGroupInfo': { type: 'LOCAL', handler: LocalHandler.tabGetGroupInfo },
  'Tab.ungroup': { type: 'LOCAL', handler: LocalHandler.tabUngroup },
  'Tab.simulateUserOpen': { type: 'LOCAL', handler: LocalHandler.tabSimulateUserOpen },
  'Tab.getTabGroup': { type: 'LOCAL', handler: LocalHandler.tabGetTabGroup },

  'SystemInfo.getInfo': { type: 'LOCAL', handler: LocalHandler.systemInfoGetInfo },
  'SystemInfo.getProcessInfo': { type: 'LOCAL', handler: LocalHandler.systemInfoGetProcessInfo },

  'Tethering.bind': { type: 'LOCAL', handler: LocalHandler.tetheringBind },
  'Tethering.unbind': { type: 'LOCAL', handler: LocalHandler.emptyResult },

  'IO.close': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'IO.read': { type: 'LOCAL', handler: LocalHandler.ioRead },
  'IO.resolveBlob': { type: 'LOCAL', handler: LocalHandler.ioResolveBlob },

  'Schema.getDomains': { type: 'LOCAL', handler: LocalHandler.schemaGetDomains },

  'Target.setAutoAttach': { type: 'SPECIAL', handler: SpecialHandler.targetSetAutoAttach },
  'Target.attachToTarget': { type: 'SPECIAL', handler: SpecialHandler.targetAttachToTarget },
  'Target.detachFromTarget': { type: 'SPECIAL', handler: SpecialHandler.targetDetachFromTarget },
  'Target.createTarget': { type: 'SPECIAL', handler: SpecialHandler.targetCreateTarget },
  'Target.activateTarget': { type: 'SPECIAL', handler: SpecialHandler.targetActivateTarget },
  'Target.closeTarget': { type: 'SPECIAL', handler: SpecialHandler.targetCloseTarget },

  'Page.startScreencast': { type: 'SPECIAL', handler: SpecialHandler.pageStartScreencast },
  'Page.stopScreencast': { type: 'SPECIAL', handler: SpecialHandler.pageStopScreencast },
  'Page.screencastFrameAck': { type: 'SPECIAL', handler: SpecialHandler.pageScreencastFrameAck },

  'Runtime.runIfWaitingForDebugger': { type: 'SPECIAL', handler: SpecialHandler.runtimeRunIfWaitingForDebugger },

  'DOM.setFileInputFiles': { type: 'SPECIAL', handler: SpecialHandler.domSetFileInputFiles }
};

function routeCDPCommand(message, connState, wsManager) {
  var id = message.id;
  var method = message.method;
  var params = message.params;
  var sessionId = message.sessionId;
  var clientId = message.clientId;
  var state = connState;

  if (!state) {
    var entry = ConnectionManager.getPrimaryConnection();
    state = entry ? entry.state : null;
    wsManager = wsManager || (entry ? entry.wsManager : null);
  }

  console.log('[CDP] routeCDPCommand id=' + id + ' (type: ' + typeof id + ') method=' + method + ' clientId=' + (clientId || 'none') + ' connId=' + (message.connectionId || 'none'));

  var route = CDP_HANDLERS[method];
  var logType = route ? route.type : 'FORWARD';
  Logger.info('[CDP] RECV id=' + id + ' method=' + method + ' type=' + logType + ' sessionId=' + (sessionId || 'null') + ' clientId=' + (clientId || 'null'));

  var ctx = { id: id, method: method, params: params, sessionId: sessionId, clientId: clientId, mode: message.mode, _state: state, _wsManager: wsManager };

  return new Promise(function(resolve) {
    if (route) {
      Promise.resolve(route.handler(ctx))
        .then(function(result) {
          if (result === null && route.type === 'SPECIAL') {
            Logger.info('[CDP] SPECIAL null -> FORWARD id=' + id + ' method=' + method);
            return ForwardHandler.execute(ctx);
          }
          return result;
        })
        .then(function(result) {
          Logger.info('[CDP] SEND id=' + id + ' method=' + method + ' hasError=false');
          resolve({ result: result });
        })
        .catch(function(error) {
          Logger.error('[CDP] ERROR id=' + id + ' method=' + method + ' msg=' + (error.message || error));
          resolve({ error: { code: error.code || -32000, message: error.message || String(error) } });
        });
    } else {
      ForwardHandler.execute(ctx)
        .then(function(result) {
          Logger.info('[CDP] SEND id=' + id + ' method=' + method + ' hasError=false (forwarded)');
          resolve({ result: result });
        })
        .catch(function(error) {
          Logger.error('[CDP] ERROR id=' + id + ' method=' + method + ' msg=' + (error.message || error) + ' (forwarded)');
          resolve({ error: { code: error.code || -32000, message: error.message || String(error) } });
        });
    }
  }).then(function(response) {
    if (response.error) {
      ResponseBuilder.send(id, null, sessionId, response.error.message, wsManager);
    } else {
      ResponseBuilder.send(id, response.result, sessionId, null, wsManager);
    }
    return response;
  });
}
