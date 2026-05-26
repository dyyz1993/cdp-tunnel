var ConnectionManager = (function() {
  var _connections = new Map();

  function init(connectionConfigs) {
    var enabled = (connectionConfigs || []).filter(function(c) { return c.enabled; });
    if (enabled.length === 0) {
      enabled.push({
        id: 'conn_default',
        tag: 'default',
        url: Config.WS_URL,
        enabled: true
      });
    }
    enabled.forEach(function(config) {
      addConnection(config);
    });
  }

  function addConnection(config) {
    if (!config || !config.id) return;
    if (_connections.has(config.id)) {
      Logger.warn('[CM] Connection already exists:', config.id);
      return;
    }

    var state = new ConnectionState(config.id);
    var wsManager = new WebSocketConnection(config.id, state, config);

    _connections.set(config.id, {
      id: config.id,
      config: config,
      state: state,
      wsManager: wsManager
    });

    Logger.info('[CM] Added connection:', config.id, config.url);
    return wsManager;
  }

  function removeConnection(connectionId) {
    var entry = _connections.get(connectionId);
    if (!entry) return;

    entry.state.clearReconnectTimer();
    if (entry.state.ws) {
      try { entry.state.ws.close(); } catch(e) {}
    }
    entry.state.clearAllState();
    _connections.delete(connectionId);
    Logger.info('[CM] Removed connection:', connectionId);
  }

  function getConnection(connectionId) {
    return _connections.get(connectionId);
  }

  function getConnectionByTabId(tabId) {
    var result = null;
    _connections.forEach(function(entry) {
      if (entry.state.isTabAttached(tabId) || entry.state.tabIdToClientId.has(tabId)) {
        result = entry;
      }
    });
    return result;
  }

  function getConnectionBySessionId(sessionId) {
    var result = null;
    _connections.forEach(function(entry) {
      if (entry.state.sessionIdToTabId.has(sessionId)) {
        result = entry;
      }
    });
    return result;
  }

  function getAllConnections() {
    return Array.from(_connections.values());
  }

  function forEachConnection(callback) {
    _connections.forEach(function(entry, id) {
      callback(entry, id);
    });
  }

  function getPrimaryConnection() {
    var first = _connections.values().next();
    return first.done ? null : first.value;
  }

  function connectAll() {
    _connections.forEach(function(entry) {
      entry.wsManager.connect();
    });
  }

  function disconnectAll() {
    _connections.forEach(function(entry) {
      if (entry.state.ws) {
        try { entry.state.ws.close(); } catch(e) {}
      }
      entry.state.clearReconnectTimer();
    });
  }

  return {
    init: init,
    addConnection: addConnection,
    removeConnection: removeConnection,
    getConnection: getConnection,
    getConnectionByTabId: getConnectionByTabId,
    getConnectionBySessionId: getConnectionBySessionId,
    getAllConnections: getAllConnections,
    forEachConnection: forEachConnection,
    getPrimaryConnection: getPrimaryConnection,
    connectAll: connectAll,
    disconnectAll: disconnectAll
  };
})();
