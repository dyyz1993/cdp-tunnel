var Config = {
  WS_URL: 'ws://localhost:19065/plugin',
  RECONNECT_DELAY: 3000,
  DEBUGGER_VERSION: '1.3',
  HEARTBEAT_INTERVAL: 25000,
  SCREENCAST_NOTIFY_THROTTLE: 16,
  BADGE_COLORS: {
    ON: '#4CAF50',
    ERR: '#F44336',
    OFF: '#9E9E9E',
    WAIT: '#FF9800'
  },
  DEFAULT_BROWSER_CONTEXT: 'default',
  DEBUG: true,

  getWsUrl: function(callback) {
    Config.getConnections(function(connections) {
      var enabled = (connections || []).filter(function(c) { return c.enabled; });
      if (enabled.length > 0) {
        callback(enabled[0].url);
        return;
      }
      callback(Config.WS_URL);
    });
  },

  getConnections: function(callback) {
    chrome.storage.local.get(['connections', 'wsAddress'], function(result) {
      if (result.connections) {
        callback(result.connections);
        return;
      }
      if (result.wsAddress) {
        var migrated = [
          {
            id: 'conn_' + Date.now(),
            tag: 'default',
            url: result.wsAddress,
            enabled: true
          }
        ];
        chrome.storage.local.set({ connections: migrated }, function() {
          callback(migrated);
        });
        return;
      }
      callback([]);
    });
  },

  setConnections: function(connections, callback) {
    chrome.storage.local.set({ connections: connections }, callback || function() {});
  },

  addConnection: function(opts, callback) {
    Config.getConnections(function(connections) {
      var conn = {
        id: 'conn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        tag: opts.tag || 'unnamed',
        url: opts.url || '',
        enabled: opts.enabled !== undefined ? opts.enabled : true
      };
      connections.push(conn);
      Config.setConnections(connections, function() {
        if (callback) callback(conn);
      });
    });
  },

  removeConnection: function(id, callback) {
    Config.getConnections(function(connections) {
      var filtered = connections.filter(function(c) { return c.id !== id; });
      Config.setConnections(filtered, callback);
    });
  },

  toggleConnection: function(id, enabled, callback) {
    Config.getConnections(function(connections) {
      connections.forEach(function(c) {
        if (c.id === id) {
          c.enabled = enabled;
        }
      });
      Config.setConnections(connections, callback);
    });
  },

  updateConnection: function(id, updates, callback) {
    Config.getConnections(function(connections) {
      connections.forEach(function(c) {
        if (c.id === id) {
          if (updates.tag !== undefined) c.tag = updates.tag;
          if (updates.url !== undefined) c.url = updates.url;
        }
      });
      Config.setConnections(connections, callback);
    });
  },

  getPluginId: function(callback) {
    chrome.storage.local.get(['pluginId'], function(result) {
      if (result.pluginId) {
        callback(result.pluginId);
      } else {
        var id = 'browser_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        chrome.storage.local.set({ pluginId: id }, function() {
          callback(id);
        });
      }
    });
  },

  AUTO_MUTE: true,
  getAutoMute: function(callback) {
    chrome.storage.local.get(['autoMute'], function(result) {
      callback(result.autoMute !== false);
    });
  },
  setAutoMute: function(enabled, callback) {
    chrome.storage.local.set({ autoMute: enabled }, callback);
  }
};
