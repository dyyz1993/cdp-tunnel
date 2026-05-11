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

  function hashCode(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      var char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  return {
    generateSessionId: generateSessionId,
    getChromeVersion: getChromeVersion,
    sleep: sleep,
    hashCode: hashCode
  };
})();
