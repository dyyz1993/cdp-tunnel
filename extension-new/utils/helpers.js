var CDPUtils = (function() {
  function generateSessionId() {
    return Array.from({ length: 32 }, function() {
      return Math.floor(Math.random() * 16).toString(16);
    }).join('').toUpperCase();
  }

  function getChromeVersion(userAgent) {
    if (!userAgent) return '';
    var match = userAgent.match(/Chrome\/([0-9.]+)/);
    return match ? match[1] : '';
  }

  function sleep(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  return {
    generateSessionId: generateSessionId,
    getChromeVersion: getChromeVersion,
    sleep: sleep
  };
})();
