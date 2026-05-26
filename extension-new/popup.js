(function() {
  var $ = function(id) { return document.getElementById(id); };

  var connectionList = $('connectionList');
  var statsRow = $('statsRow');
  var statClients = $('statClients');
  var statPages = $('statPages');

  function loadState() {
    chrome.runtime.sendMessage({ type: 'get-connection-statuses' }, function(resp) {
      if (!resp || !resp.connections) return;
      renderConnectionList(resp.connections);
      updateStats(resp.connections);
    });
  }

  function renderConnectionList(connections) {
    connectionList.innerHTML = '';

    if (!connections || connections.length === 0) {
      connectionList.innerHTML = '<div class="empty-hint">尚未配置连接</div>';
      return;
    }

    connections.forEach(function(conn) {
      var item = document.createElement('div');
      item.className = 'conn-item';

      var header = document.createElement('div');
      header.className = 'conn-header';

      var dot = document.createElement('span');
      dot.className = 'conn-dot ' + conn.status;

      var modeIcon = conn.mode === 'takeover' ? '🔗 ' : '🆕 ';

      var tag = document.createElement('span');
      tag.className = 'conn-tag';
      tag.textContent = modeIcon + conn.tag;

      header.appendChild(dot);
      header.appendChild(tag);

      var url = document.createElement('div');
      url.className = 'conn-url';
      url.textContent = conn.url;

      item.appendChild(header);
      item.appendChild(url);
      connectionList.appendChild(item);
    });
  }

  function updateStats(connections) {
    var active = 0;
    var pages = 0;
    connections.forEach(function(conn) {
      if (conn.status === 'connected') active++;
      pages += conn.attachedCount || 0;
    });

    if (active > 0 || pages > 0) {
      statsRow.style.display = '';
    } else {
      statsRow.style.display = 'none';
    }
    statClients.textContent = active;
    statPages.textContent = pages;
  }

  var openConfigBtn = $('openConfigBtn');
  openConfigBtn.addEventListener('click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('config-page-preview.html') });
  });

  var versionLink = $('versionLink');
  var manifest = chrome.runtime.getManifest();
  versionLink.textContent = 'v' + manifest.version;

  loadState();

  chrome.runtime.onMessage.addListener(function(message) {
    if (message.type === 'connection-status-changed' || message.type === 'stateUpdate') {
      loadState();
    }
  });
})();
