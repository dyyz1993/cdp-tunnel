var Config = {
  WS_URL: 'ws://localhost:37171/plugin',
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
    chrome.storage.local.get(['wsAddress'], function(result) {
      callback(result.wsAddress || Config.WS_URL);
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
