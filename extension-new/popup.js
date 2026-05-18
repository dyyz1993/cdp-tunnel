(function() {
  var $ = function(id) { return document.getElementById(id); };

  var wsInput = $('wsInput');
  var saveBtn = $('saveBtn');
  var statusBadge = $('statusBadge');
  var statusText = $('statusText');
  var cdpSection = $('cdpSection');
  var cdpAddresses = $('cdpAddresses');
  var clientsSection = $('clientsSection');
  var clientsInfo = $('clientsInfo');

  function loadState() {
    chrome.storage.local.get(['wsAddress'], function(result) {
      wsInput.value = result.wsAddress || '';
    });
    chrome.runtime.sendMessage({ type: 'popup-query' }, function(state) {
      if (!state) return;
      updateStatus(state);
      updateCDP(state);
      updateClients(state);
    });
  }

  function updateStatus(state) {
    var cls = state.connected ? 'on' : 'off';
    var text = state.connected ? '已连接' : '未连接';
    if (!state.connected && state.lastError) {
      cls = 'err';
      text = '错误';
    }
    statusBadge.className = 'status-badge ' + cls;
    statusText.textContent = text;
  }

  function updateCDP(state) {
    if (!state.connected || !state.pluginId) {
      cdpSection.style.display = 'none';
      return;
    }
    cdpSection.style.display = '';

    var wsUrl = wsInput.value || 'ws://localhost:9221/plugin';
    var cdpBase = wsUrl.replace(/\/plugin(\?.*)?$/, '');
    var pluginId = state.pluginId;
    var cdpPath = '/devtools/browser/' + pluginId;

    var urls = [];
    var parsed = parseWsUrl(wsUrl);
    if (parsed) {
      urls.push({ label: 'CDP 地址', url: parsed.protocol + '://' + parsed.host + cdpPath });
    }

    var html = '';
    urls.forEach(function(item) {
      html += '<div class="cdp-row">';
      html += '<div class="cdp-label">' + item.label + '</div>';
      html += '<div class="cdp-url">';
      html += '<code>' + escapeHtml(item.url) + '</code>';
      html += '<button class="copy-btn" data-url="' + escapeAttr(item.url) + '">复制</button>';
      html += '</div></div>';
    });
    cdpAddresses.innerHTML = html;
  }

  function updateClients(state) {
    if (!state.connected) {
      clientsSection.style.display = 'none';
      return;
    }
    clientsSection.style.display = '';
    var clients = state.cdpClients || [];
    var attached = state.attachedPages || [];
    clientsInfo.innerHTML = '活跃连接: <span>' + clients.length + '</span> | 已附加页面: <span>' + attached.length + '</span>';
  }

  function parseWsUrl(url) {
    var m = url.match(/^(wss?):\/\/([^\/]+)/);
    if (!m) return null;
    return { protocol: m[1], host: m[2] };
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeAttr(s) {
    return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  saveBtn.addEventListener('click', function() {
    var val = wsInput.value.trim();
    chrome.storage.local.set({ wsAddress: val }, function() {
      saveBtn.textContent = '已保存';
      setTimeout(function() { saveBtn.textContent = '保存'; }, 1500);
      chrome.runtime.sendMessage({ type: 'ws-reconnect' });
    });
  });

  cdpAddresses.addEventListener('click', function(e) {
    var btn = e.target.closest('.copy-btn');
    if (!btn) return;
    var url = btn.getAttribute('data-url');
    navigator.clipboard.writeText(url).then(function() {
      btn.textContent = '已复制';
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = '复制';
        btn.classList.remove('copied');
      }, 2000);
    });
  });

  loadState();
})();
