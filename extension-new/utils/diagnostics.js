var Diagnostics = (function() {
  var _stats = {
    startTime: Date.now(),
    messagesReceived: 0,
    messagesSent: 0,
    bytesReceived: 0,
    bytesSent: 0,
    blobMessages: 0,
    pendingBlobs: 0,
    blobErrors: 0,
    largeMessages: 0,
    bufferedAmountPeaks: [],
    errors: [],
    disconnectReasons: [],
    chromeDebuggerEvents: 0,
    chromeDebuggerDropped: 0,
    messageRateHistory: [],
    lastRateCheck: Date.now(),
    messagesInLastSecond: 0,
    tabEvents: [],
    debuggerEvents: [],
    sessionMappings: []
  };

  var _config = {
    largeMessageThreshold: 100000,
    bufferedAmountThreshold: 50000,
    logInterval: 5000,
    rateCheckInterval: 1000,
    maxEventsToKeep: 50
  };

  var _intervals = [];
  var _originalWebSocketSend = null;
  var _isMonitoring = false;

  function startMonitoring() {
    if (_isMonitoring) {
      console.log('[DIAG] Already monitoring');
      return;
    }
    _isMonitoring = true;
    _stats.startTime = Date.now();

    console.log('%c[DIAG] ========== 诊断监控已启动 ==========', 
                'background: #4CAF50; color: white; font-size: 14px; padding: 5px;');
    console.log('[DIAG] 配置:', _config);

    monitorWebSocket();
    monitorRate();
    monitorChromeDebugger();
    monitorTabs();
    startPeriodicLog();

    console.log('[DIAG] 可用命令:');
    console.log('  - Diagnostics.getReport()  // 获取完整报告');
    console.log('  - Diagnostics.getTimeline() // 获取事件时间线');
    console.log('  - Diagnostics.reset()      // 重置统计');
    console.log('  - Diagnostics.stop()       // 停止监控');
  }

  function monitorWebSocket() {
    var ws = State.getWs();
    if (!ws) {
      console.log('[DIAG] WebSocket未初始化，等待连接...');
      setTimeout(monitorWebSocket, 1000);
      return;
    }

    console.log('[DIAG] WebSocket已找到，开始监控');

    var originalOnMessage = ws.onmessage;
    ws.onmessage = function(event) {
      var data = event.data;
      var size = data.size || data.length || 0;
      
      _stats.messagesReceived++;
      _stats.bytesReceived += size;
      _stats.messagesInLastSecond++;

      if (size > _config.largeMessageThreshold) {
        _stats.largeMessages++;
        console.warn('[DIAG] 大消息:', size, 'bytes');
      }

      if (data instanceof Blob) {
        _stats.blobMessages++;
        _stats.pendingBlobs++;
        console.log('[DIAG] Blob消息, size:', data.size, 'pending:', _stats.pendingBlobs);
        
        data.text().then(function(text) {
          _stats.pendingBlobs--;
        }).catch(function(e) {
          _stats.pendingBlobs--;
          _stats.blobErrors++;
          console.error('[DIAG] Blob处理错误:', e);
        });
      }

      if (originalOnMessage) {
        originalOnMessage.call(ws, event);
      }
    };

    var originalOnClose = ws.onclose;
    ws.onclose = function(event) {
      var reason = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        time: Date.now(),
        uptime: Date.now() - _stats.startTime,
        stats: getStats()
      };
      _stats.disconnectReasons.push(reason);
      
      console.error('%c[DIAG] WebSocket断开!', 'background: #F44336; color: white; font-size: 14px;');
      console.error('[DIAG] 断开详情:', reason);
      console.error('[DIAG] 断开代码含义:', getCloseCodeMeaning(event.code));
      
      addTimelineEvent('WS_CLOSE', {
        code: event.code,
        reason: event.reason,
        meaning: getCloseCodeMeaning(event.code)
      });
      
      if (originalOnClose) {
        originalOnClose.call(ws, event);
      }
    };

    var originalOnError = ws.onerror;
    ws.onerror = function(event) {
      _stats.errors.push({
        time: Date.now(),
        type: 'WebSocket error',
        event: event
      });
      console.error('[DIAG] WebSocket错误:', event);
      
      addTimelineEvent('WS_ERROR', { event: event });
      
      if (originalOnError) {
        originalOnError.call(ws, event);
      }
    };

    _originalWebSocketSend = ws.send.bind(ws);
    ws.send = function(data) {
      var size = data.length || data.size || 0;
      _stats.messagesSent++;
      _stats.bytesSent += size;

      var bufferedAmount = ws.bufferedAmount;
      if (bufferedAmount > _config.bufferedAmountThreshold) {
        _stats.bufferedAmountPeaks.push({
          time: Date.now(),
          amount: bufferedAmount,
          messageSize: size
        });
        console.warn('[DIAG] 缓冲区警告:', bufferedAmount, 'bytes');
        addTimelineEvent('BUFFER_HIGH', { 
          bufferedAmount: bufferedAmount,
          messageSize: size
        });
      }

      try {
        _originalWebSocketSend(data);
      } catch (e) {
        _stats.errors.push({
          time: Date.now(),
          type: 'Send error',
          error: e.message
        });
        console.error('[DIAG] 发送错误:', e);
        addTimelineEvent('SEND_ERROR', { error: e.message });
      }
    };
  }

  function monitorChromeDebugger() {
    var originalListener = null;
    
    chrome.debugger.onEvent.addListener(function(source, method, params) {
      _stats.chromeDebuggerEvents++;
      
      var eventInfo = {
        time: Date.now(),
        tabId: source.tabId,
        method: method,
        paramsSize: params ? JSON.stringify(params).length : 0
      };
      
      _stats.debuggerEvents.push(eventInfo);
      if (_stats.debuggerEvents.length > _config.maxEventsToKeep) {
        _stats.debuggerEvents.shift();
      }

      if (method.startsWith('Network.') || method.startsWith('Log.')) {
        // 网络和日志事件可能很多，只记录简要信息
        if (params && JSON.stringify(params).length > 10000) {
          console.warn('[DIAG] 大量调试器事件数据:', method, 'size:', JSON.stringify(params).length);
        }
      } else {
        addTimelineEvent('DEBUGGER_EVENT', {
          tabId: source.tabId,
          method: method,
          paramsSize: eventInfo.paramsSize
        });
      }
    });

    chrome.debugger.onDetach.addListener(function(source, reason) {
      console.warn('%c[DIAG] chrome.debugger 断开!', 'background: #FF5722; color: white; font-size: 12px;');
      console.warn('[DIAG] Tab ID:', source.tabId, '原因:', reason);
      
      addTimelineEvent('DEBUGGER_DETACH', {
        tabId: source.tabId,
        reason: reason
      });
      
      var session = State.findSessionByTabId(source.tabId);
      if (session) {
        console.warn('[DIAG] 受影响的Session:', session);
      }
    });
  }

  function monitorTabs() {
    chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
      console.warn('%c[DIAG] Tab被关闭!', 'background: #E91E63; color: white; font-size: 12px;');
      console.warn('[DIAG] Tab ID:', tabId, '窗口ID:', removeInfo.windowId);
      
      addTimelineEvent('TAB_REMOVED', {
        tabId: tabId,
        windowId: removeInfo.windowId,
        isWindowClosing: removeInfo.isWindowClosing
      });

      var session = State.findSessionByTabId(tabId);
      if (session) {
        console.warn('[DIAG] Tab关闭将影响Session:', session);
      }
    });

    chrome.tabs.onReplaced.addListener(function(addedTabId, removedTabId) {
      console.warn('[DIAG] Tab被替换:', removedTabId, '->', addedTabId);
      addTimelineEvent('TAB_REPLACED', {
        addedTabId: addedTabId,
        removedTabId: removedTabId
      });
    });
  }

  function addTimelineEvent(type, data) {
    var event = {
      time: Date.now(),
      timestamp: new Date().toISOString(),
      type: type,
      data: data
    };
    
    _stats.tabEvents.push(event);
    if (_stats.tabEvents.length > _config.maxEventsToKeep * 2) {
      _stats.tabEvents.shift();
    }
  }

  function getTimeline() {
    console.log('%c[DIAG] ========== 事件时间线 ==========', 
                'background: #673AB7; color: white; font-size: 14px; padding: 5px;');
    
    if (_stats.tabEvents.length === 0) {
      console.log('暂无事件记录');
      return [];
    }

    console.table(_stats.tabEvents.map(function(e) {
      return {
        '时间': e.timestamp,
        '类型': e.type,
        '详情': JSON.stringify(e.data).substring(0, 100)
      };
    }));

    console.log('\n📊 事件类型统计:');
    var typeCounts = {};
    _stats.tabEvents.forEach(function(e) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    });
    console.table(typeCounts);

    return _stats.tabEvents;
  }

  function monitorRate() {
    var interval = setInterval(function() {
      var now = Date.now();
      var elapsed = now - _stats.lastRateCheck;
      
      if (elapsed >= _config.rateCheckInterval) {
        var rate = _stats.messagesInLastSecond / (elapsed / 1000);
        _stats.messageRateHistory.push({
          time: now,
          rate: rate,
          pendingBlobs: _stats.pendingBlobs
        });

        if (_stats.messageRateHistory.length > 60) {
          _stats.messageRateHistory.shift();
        }

        _stats.messagesInLastSecond = 0;
        _stats.lastRateCheck = now;
      }
    }, _config.rateCheckInterval);
    _intervals.push(interval);
  }

  function startPeriodicLog() {
    var interval = setInterval(function() {
      var ws = State.getWs();
      var bufferedAmount = ws ? ws.bufferedAmount : 0;
      var readyState = ws ? ws.readyState : -1;
      
      console.log('%c[DIAG] 状态报告', 'background: #2196F3; color: white;');
      console.log('  运行时间:', Math.round((Date.now() - _stats.startTime) / 1000), '秒');
      console.log('  WebSocket状态:', getReadyStateText(readyState));
      console.log('  缓冲区:', bufferedAmount, 'bytes');
      console.log('  消息统计:');
      console.log('    - 接收:', _stats.messagesReceived, '条', formatBytes(_stats.bytesReceived));
      console.log('    - 发送:', _stats.messagesSent, '条', formatBytes(_stats.bytesSent));
      console.log('    - 大消息:', _stats.largeMessages, '条');
      console.log('    - Blob消息:', _stats.blobMessages, '条');
      console.log('    - 待处理Blob:', _stats.pendingBlobs);
      console.log('    - Blob错误:', _stats.blobErrors);
      console.log('  调试器事件:', _stats.chromeDebuggerEvents, '条');
      console.log('  Tab事件:', _stats.tabEvents.length, '条');
      
      var attachedTabs = State.getAttachedTabIds();
      console.log('  已附加的Tab:', attachedTabs.length, '个');
      
      if (_stats.messageRateHistory.length > 0) {
        var lastRate = _stats.messageRateHistory[_stats.messageRateHistory.length - 1];
        console.log('  消息速率:', lastRate.rate.toFixed(1), '条/秒');
      }

      if (_stats.bufferedAmountPeaks.length > 0) {
        var lastPeak = _stats.bufferedAmountPeaks[_stats.bufferedAmountPeaks.length - 1];
        console.log('  最近缓冲区峰值:', lastPeak.amount, 'bytes');
      }
    }, _config.logInterval);
    _intervals.push(interval);
  }

  function getStats() {
    var ws = State.getWs();
    return {
      uptime: Date.now() - _stats.startTime,
      webSocket: {
        readyState: ws ? ws.readyState : -1,
        bufferedAmount: ws ? ws.bufferedAmount : 0
      },
      messages: {
        received: _stats.messagesReceived,
        sent: _stats.messagesSent,
        bytesReceived: _stats.bytesReceived,
        bytesSent: _stats.bytesSent,
        largeMessages: _stats.largeMessages,
        blobMessages: _stats.blobMessages,
        pendingBlobs: _stats.pendingBlobs,
        blobErrors: _stats.blobErrors
      },
      debugger: {
        events: _stats.chromeDebuggerEvents,
        recentEvents: _stats.debuggerEvents.slice(-10)
      },
      tabs: {
        events: _stats.tabEvents.length,
        recentEvents: _stats.tabEvents.slice(-10)
      },
      peaks: _stats.bufferedAmountPeaks.slice(-10),
      errors: _stats.errors.slice(-10),
      disconnects: _stats.disconnectReasons,
      rateHistory: _stats.messageRateHistory.slice(-10)
    };
  }

  function getReport() {
    var stats = getStats();
    
    console.log('%c[DIAG] ========== 完整诊断报告 ==========', 
                'background: #9C27B0; color: white; font-size: 16px; padding: 10px;');
    
    console.log('\n📊 基本统计:');
    console.table({
      '运行时间(秒)': Math.round(stats.uptime / 1000),
      '接收消息数': stats.messages.received,
      '发送消息数': stats.messages.sent,
      '接收字节数': formatBytes(stats.messages.bytesReceived),
      '发送字节数': formatBytes(stats.messages.bytesSent),
      '大消息数': stats.messages.largeMessages,
      'Blob消息数': stats.messages.blobMessages,
      '待处理Blob': stats.messages.pendingBlobs,
      'Blob错误数': stats.messages.blobErrors,
      '调试器事件数': stats.debugger.events,
      'Tab事件数': stats.tabs.events
    });

    console.log('\n🔌 WebSocket状态:');
    console.table({
      '状态': getReadyStateText(stats.webSocket.readyState),
      '缓冲区': formatBytes(stats.webSocket.bufferedAmount)
    });

    if (stats.peaks.length > 0) {
      console.log('\n📈 缓冲区峰值 (最近10次):');
      console.table(stats.peaks.map(function(p) {
        return {
          '时间': new Date(p.time).toLocaleTimeString(),
          '缓冲区': formatBytes(p.amount),
          '消息大小': formatBytes(p.messageSize)
        };
      }));
    }

    if (stats.rateHistory.length > 0) {
      console.log('\n⚡ 消息速率历史 (最近10次):');
      console.table(stats.rateHistory.map(function(r) {
        return {
          '时间': new Date(r.time).toLocaleTimeString(),
          '速率(条/秒)': r.rate.toFixed(1),
          '待处理Blob': r.pendingBlobs
        };
      }));
    }

    if (stats.errors.length > 0) {
      console.log('\n❌ 错误记录:');
      console.table(stats.errors.map(function(e) {
        return {
          '时间': new Date(e.time).toLocaleTimeString(),
          '类型': e.type,
          '详情': e.error || e.event || '-'
        };
      }));
    }

    if (stats.disconnects.length > 0) {
      console.log('\n🔌 断开记录:');
      stats.disconnects.forEach(function(d, i) {
        console.log('断开 #' + (i + 1) + ':');
        console.log('  代码:', d.code, '-', getCloseCodeMeaning(d.code));
        console.log('  原因:', d.reason || '无');
        console.log('  正常关闭:', d.wasClean);
        console.log('  运行时间:', Math.round(d.uptime / 1000), '秒');
      });
    }

    if (stats.tabs.recentEvents.length > 0) {
      console.log('\n📋 最近的Tab/调试器事件:');
      console.table(stats.tabs.recentEvents.map(function(e) {
        return {
          '时间': e.timestamp || new Date(e.time).toLocaleTimeString(),
          '类型': e.type,
          '详情': JSON.stringify(e.data).substring(0, 80)
        };
      }));
    }

    return stats;
  }

  function getCloseCodeMeaning(code) {
    var meanings = {
      1000: '正常关闭',
      1001: '端点离开',
      1002: '协议错误',
      1003: '不支持的数据类型',
      1005: '无状态码',
      1006: '连接异常断开 (可能是网络问题或缓冲区溢出)',
      1007: '数据类型不一致',
      1008: '违反策略',
      1009: '消息过大',
      1010: '扩展协商失败',
      1011: '内部错误',
      1012: '服务重启',
      1013: '稍后重试',
      1014: '网关错误',
      1015: 'TLS握手失败'
    };
    return meanings[code] || '未知代码';
  }

  function getReadyStateText(state) {
    var states = {
      0: 'CONNECTING',
      1: 'OPEN',
      2: 'CLOSING',
      3: 'CLOSED'
    };
    return states[state] || 'UNKNOWN';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function reset() {
    _stats = {
      startTime: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      blobMessages: 0,
      pendingBlobs: 0,
      blobErrors: 0,
      largeMessages: 0,
      bufferedAmountPeaks: [],
      errors: [],
      disconnectReasons: [],
      chromeDebuggerEvents: 0,
      chromeDebuggerDropped: 0,
      messageRateHistory: [],
      lastRateCheck: Date.now(),
      messagesInLastSecond: 0,
      tabEvents: [],
      debuggerEvents: [],
      sessionMappings: []
    };
    console.log('[DIAG] 统计已重置');
  }

  function stop() {
    _intervals.forEach(function(interval) {
      clearInterval(interval);
    });
    _intervals = [];
    _isMonitoring = false;
    console.log('[DIAG] 监控已停止');
  }

  return {
    start: startMonitoring,
    stop: stop,
    reset: reset,
    getReport: getReport,
    getStats: getStats,
    getTimeline: getTimeline
  };
})();

console.log('%c[DIAG] 诊断模块已加载', 'background: #FF9800; color: white; padding: 3px;');
console.log('[DIAG] 运行 Diagnostics.start() 开始监控');
