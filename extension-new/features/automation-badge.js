var AutomationBadge = (function() {
  var PREFIX = '[Automation] ';
  var BADGE_CONTAINER_ID = '__cdp_automation_badge_container__';

  var INJECT_STYLE_SCRIPT = function() {
    if (document.getElementById('__cdp_automation_styles__')) return;
    var style = document.createElement('style');
    style.id = '__cdp_automation_styles__';
    style.textContent = '\n      .__cdp_automation_badge__ {\n        position: fixed;\n        bottom: 10px;\n        right: 10px;\n        background: rgba(255, 152, 0, 0.95);\n        color: white;\n        padding: 6px 12px;\n        border-radius: 4px;\n        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n        font-size: 12px;\n        font-weight: 500;\n        z-index: 2147483647;\n        box-shadow: 0 2px 8px rgba(0,0,0,0.3);\n        pointer-events: none;\n        user-select: none;\n      }\n    ';
    document.head.appendChild(style);
  };

  var INJECT_BADGE_SCRIPT = function() {
    if (document.getElementById('__cdp_automation_badge_container__')) return;
    var container = document.createElement('div');
    container.id = '__cdp_automation_badge_container__';
    var badge = document.createElement('div');
    badge.className = '__cdp_automation_badge__';
    badge.textContent = 'Automation';
    container.appendChild(badge);
    document.body.appendChild(container);
  };

  var REMOVE_BADGE_SCRIPT = function() {
    var container = document.getElementById('__cdp_automation_badge_container__');
    if (container) container.remove();
  };

  var UPDATE_TITLE_SCRIPT = function(prefix) {
    if (!document.title.startsWith(prefix)) {
      document.title = prefix + document.title.replace(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');
    }
  };

  var RESTORE_TITLE_SCRIPT = function(prefix) {
    if (document.title.startsWith(prefix)) {
      document.title = document.title.slice(prefix.length);
    }
  };

  function inject(tabId) {
    State.addAutomatedTab(tabId);

    injectStyle(tabId);
    injectBadge(tabId);
    updateTitle(tabId);
  }

  function remove(tabId) {
    State.removeAutomatedTab(tabId);

    removeBadge(tabId);
    restoreTitle(tabId);
  }

  function injectStyle(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: INJECT_STYLE_SCRIPT
    }).catch(function() {});
  }

  function injectBadge(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: INJECT_BADGE_SCRIPT
    }).catch(function() {});
  }

  function removeBadge(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: REMOVE_BADGE_SCRIPT
    }).catch(function() {});
  }

  function updateTitle(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: UPDATE_TITLE_SCRIPT,
      args: [PREFIX]
    }).catch(function() {});
  }

  function restoreTitle(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: RESTORE_TITLE_SCRIPT,
      args: [PREFIX]
    }).catch(function() {});
  }

  function refreshAll() {
    var automatedTabs = State.getAutomatedTabs();
    automatedTabs.forEach(function(tabId) {
      chrome.tabs.get(tabId, function(tab) {
        if (tab && tab.id) {
          inject(tabId);
        } else {
          State.removeAutomatedTab(tabId);
        }
      }).catch(function() {
        State.removeAutomatedTab(tabId);
      });
    });
  }

  return {
    inject: inject,
    remove: remove,
    refreshAll: refreshAll
  };
})();
