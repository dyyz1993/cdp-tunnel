var Screencast = (function() {
  var CHANGE_DETECTOR_SCRIPT = (function() {
    return function() {
      if (window.__cdpChangeDetectorInjected) {
        window.__cdpChangePaused = false;
        if (typeof window.__cdpCheckAnimations === 'function') {
          requestAnimationFrame(window.__cdpCheckAnimations);
        }
        return;
      }
      window.__cdpChangeDetectorInjected = true;
      window.__cdpChangePaused = false;
      window.__cdpChangeNotify = function() {
        if (window.__cdpChangePaused) return;
        if (window.__cdpChangeNotifyPending) return;
        window.__cdpChangeNotifyPending = true;
        requestAnimationFrame(function() {
          window.__cdpChangeNotifyPending = false;
          if (typeof __notifyChange === 'function') {
            __notifyChange('change');
          }
        });
      };
      var observer = new MutationObserver(window.__cdpChangeNotify);
      window.__cdpMutationObserver = observer;
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      var events = ['scroll', 'wheel', 'resize'];
      window.__cdpEventNames = events;
      for (var i = 0; i < events.length; i++) {
        document.addEventListener(events[i], window.__cdpChangeNotify, true);
      }
      try {
        var mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (!mediaQuery.matches) {
          var lastAnimTime = 0;
          var checkAnimations = function() {
            if (window.__cdpChangePaused || !window.__cdpChangeDetectorInjected) {
              return;
            }
            var animations = document.getAnimations();
            var now = Date.now();
            if (animations.length > 0 && now - lastAnimTime > 100) {
              lastAnimTime = now;
              window.__cdpChangeNotify();
            }
            var videos = document.querySelectorAll('video');
            for (var i = 0; i < videos.length; i++) {
              var v = videos[i];
              if (!v.paused && !v.ended) {
                window.__cdpChangeNotify();
                break;
              }
            }
            var canvases = document.querySelectorAll('canvas');
            if (canvases.length > 0) {
              window.__cdpChangeNotify();
            }
            if (window.__cdpChangeDetectorInjected && !window.__cdpChangePaused) {
              requestAnimationFrame(checkAnimations);
            }
          };
          window.__cdpCheckAnimations = checkAnimations;
          requestAnimationFrame(checkAnimations);
        }
      } catch (e) {}
    };
  })();

  function startPolling(tabId, params, sessionId) {
    stopPolling(tabId);

    var session = {
      tabId: tabId,
      sessionId: sessionId,
      format: (params && params.format) || 'jpeg',
      quality: (params && params.quality !== undefined) ? params.quality : 80,
      maxWidth: (params && params.maxWidth) || 1920,
      maxHeight: (params && params.maxHeight) || 1080,
      everyNthFrame: (params && params.everyNthFrame) || 1,
      frameCount: 0,
      pendingAck: false,
      stopped: false,
      lastFrameData: null,
      frameId: 0
    };

    State.setScreencastSession(tabId, session);

    return injectChangeDetector(tabId).then(function() {
      captureAndSendFrame(session);
    });
  }

  function stopPolling(tabId) {
    var session = State.getScreencastSession(tabId);
    if (session) {
      session.stopped = true;
      State.deleteScreencastSession(tabId);
      disableChangeNotify(tabId);
    }
  }

  function ackFrame(tabId, ackSessionId) {
    var session = State.getScreencastSession(tabId);
    if (session) {
      session.pendingAck = false;
      captureAndSendFrame(session);
    }
  }

  function injectChangeDetector(tabId) {
    return chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.enable')
      .then(function() {
        Logger.info('[Screencast] Runtime enabled');
        return chrome.debugger.sendCommand(
          { tabId: tabId },
          'Runtime.addBinding',
          { name: '__notifyChange' }
        );
      })
      .then(function() {
        Logger.info('[Screencast] Binding __notifyChange added');
        var scriptStr = CHANGE_DETECTOR_SCRIPT.toString();
        return chrome.debugger.sendCommand(
          { tabId: tabId },
          'Runtime.evaluate',
          { expression: '(' + scriptStr + ')()' }
        );
      })
      .then(function(result) {
        if (result.exceptionDetails) {
          Logger.warn('[Screencast] Failed to inject change detector:', result.exceptionDetails);
          return false;
        }
        Logger.info('[Screencast] Change detector injected');
        return true;
      })
      .catch(function(error) {
        Logger.warn('[Screencast] Failed to inject change detector:', error.message);
        return false;
      });
  }

  function disableChangeNotify(tabId) {
    return chrome.debugger.sendCommand(
      { tabId: tabId },
      'Runtime.evaluate',
      { expression: 'window.__cdpChangePaused = true;' }
    ).catch(function() {});
  }

  function captureAndSendFrame(session) {
    if (session.stopped) return;

    session.frameCount++;
    if (session.frameCount % session.everyNthFrame !== 0) return;

    chrome.debugger.sendCommand(
      { tabId: session.tabId },
      'Page.captureScreenshot',
      {
        format: session.format,
        quality: session.quality,
        maxWidth: session.maxWidth,
        maxHeight: session.maxHeight
      }
    ).then(function(result) {
      if (session.stopped || !result || !result.data) return;

      var data = result.data;
      if (session.lastFrameData === data) {
        return;
      }
      session.lastFrameData = data;

      session.frameId++;
      var frameId = session.frameId;

      EventBuilder.send('Page.screencastFrame', {
        data: data,
        sessionId: session.sessionId,
        frameId: frameId,
        metadata: {
          deviceWidth: session.maxWidth,
          deviceHeight: session.maxHeight,
          pageScaleFactor: 1,
          offsetTop: 0,
          offsetBottom: 0,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: Date.now()
        }
      }, session.sessionId);

      session.pendingAck = true;
    }).catch(function(error) {
      if (!session.stopped) {
        Logger.warn('[Screencast] Screenshot failed:', error.message);
      }
    });
  }

  function onNotify(tabId) {
    var session = State.getScreencastSession(tabId);
    if (session && !session.pendingAck && !session.stopped) {
      captureAndSendFrame(session);
    }
  }

  return {
    startPolling: startPolling,
    stopPolling: stopPolling,
    ackFrame: ackFrame,
    onNotify: onNotify
  };
})();
