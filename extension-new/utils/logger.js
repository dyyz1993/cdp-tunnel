var Logger = (function() {
  var PREFIX = '[CDP Bridge]';
  var DEBUG = true;

  function formatArgs(args) {
    return Array.from(args).map(function(arg) {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }

  function log(level) {
    var args = Array.from(arguments).slice(1);
    var timestamp = new Date().toISOString();
    var prefix = '[' + timestamp + '] ' + PREFIX + ' [' + level + ']';
    var message = prefix + ' ' + formatArgs(args);
    
    switch(level) {
      case 'ERROR':
        console.error(message);
        break;
      case 'WARN':
        console.warn(message);
        break;
      default:
        console.log(message);
    }
  }

  function info() {
    var args = ['INFO'].concat(Array.from(arguments));
    log.apply(null, args);
  }

  function warn() {
    var args = ['WARN'].concat(Array.from(arguments));
    log.apply(null, args);
  }

  function error() {
    var args = ['ERROR'].concat(Array.from(arguments));
    log.apply(null, args);
  }

  function debug() {
    if (!DEBUG) return;
    var args = ['DEBUG'].concat(Array.from(arguments));
    log.apply(null, args);
  }

  return {
    info: info,
    warn: warn,
    error: error,
    debug: debug,
    log: info
  };
})();
