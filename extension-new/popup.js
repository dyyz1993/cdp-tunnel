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

  function getCdpAddress(wsUrl, mode) {
    var match = (wsUrl || '').match(/:\/\/([^\/]+):(\d+)/);
    if (!match) return '';
    var host = match[1];
    var port = parseInt(match[2], 10);
    if (mode === 'takeover') port += 1;
    return 'http://' + host + ':' + port;
  }

  function renderConnectionList(connections) {
    connectionList.innerHTML = '';

    if (!connections || connections.length === 0) {
      var guideHtml = `
        <div class="first-time-guide">
          <div class="guide-icon">👋</div>
          <div class="guide-text">
            <strong>首次使用？</strong><br>
            请先启动 cdp-tunnel server，然后点击下方按钮配置连接
          </div>
        </div>
      `;
      connectionList.innerHTML = guideHtml;
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
      url.textContent = 'WS:  ' + conn.url;

      item.appendChild(header);
      item.appendChild(url);

      var cdpAddr = conn.cdpAddress || getCdpAddress(conn.url, conn.mode);
      if (cdpAddr) {
        var cdpRow = document.createElement('div');
        cdpRow.className = 'conn-cdp';

        var cdpLabel = document.createElement('span');
        cdpLabel.className = 'conn-cdp-label';
        cdpLabel.textContent = 'CDP: ';

        var cdpValue = document.createElement('span');
        cdpValue.className = 'conn-cdp-value';
        cdpValue.textContent = cdpAddr;

        var copyBtn = document.createElement('button');
        copyBtn.className = 'conn-cdp-copy';
        copyBtn.textContent = '📋';
        copyBtn.title = '复制';
        copyBtn.addEventListener('click', function(ev) {
          ev.stopPropagation();
          navigator.clipboard.writeText(cdpAddr).then(function() {
            copyBtn.textContent = '✓';
            setTimeout(function() { copyBtn.textContent = '📋'; }, 1200);
          });
        });

        cdpRow.appendChild(cdpLabel);
        cdpRow.appendChild(cdpValue);
        cdpRow.appendChild(copyBtn);
        item.appendChild(cdpRow);
      }

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
