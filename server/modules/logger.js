const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(logDir, 'cdp-debug.log');
const statusLogFile = path.join(logDir, 'server-status.log');

const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const MAX_TOTAL_LOG_SIZE = 30 * 1024 * 1024;

let logWriteQueue = [];
let isWritingLog = false;
let statusWriteQueue = [];
let isWritingStatus = false;

function checkAndRotateLog(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size >= MAX_LOG_SIZE) {
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);
      const dir = path.dirname(filePath);
      
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const oldFile = path.join(dir, `${base}.${i}${ext}`);
        const newFile = path.join(dir, `${base}.${i + 1}${ext}`);
        if (fs.existsSync(oldFile)) {
          if (i === MAX_LOG_FILES - 1) {
            fs.unlinkSync(oldFile);
          } else {
            fs.renameSync(oldFile, newFile);
          }
        }
      }
      
      const firstBackup = path.join(dir, `${base}.1${ext}`);
      fs.renameSync(filePath, firstBackup);
      return true;
    }
  } catch (e) {
    // 文件不存在，忽略
  }
  return false;
}

function flushLogQueue() {
  if (logWriteQueue.length === 0 || isWritingLog) return;
  
  isWritingLog = true;
  const dataToWrite = logWriteQueue.join('');
  logWriteQueue = [];
  
  fs.writeFile(logFile, dataToWrite, { flag: 'a' }, (err) => {
    isWritingLog = false;
    if (err) console.error('[LOGGER] Error writing log:', err.message);
    
    if (logWriteQueue.length > 0) {
      setImmediate(flushLogQueue);
    }
  });
}

function flushStatusQueue() {
  if (statusWriteQueue.length === 0 || isWritingStatus) return;
  
  isWritingStatus = true;
  const dataToWrite = statusWriteQueue.join('');
  statusWriteQueue = [];
  
  fs.writeFile(statusLogFile, dataToWrite, { flag: 'a' }, (err) => {
    isWritingStatus = false;
    if (err) console.error('[LOGGER] Error writing status log:', err.message);
    
    if (statusWriteQueue.length > 0) {
      setImmediate(flushStatusQueue);
    }
  });
}

function checkLogRotation() {
  checkAndRotateLog(logFile);
  checkAndRotateLog(statusLogFile);
  cleanupOldLogs();
}

function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).map(f => {
      const fp = path.join(logDir, f);
      try {
        return { path: fp, stat: fs.statSync(fp) };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

    let totalSize = files.reduce((sum, f) => sum + f.stat.size, 0);
    while (totalSize > MAX_TOTAL_LOG_SIZE && files.length > 1) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.path);
      totalSize -= oldest.stat.size;
    }
  } catch {}
}

setInterval(checkLogRotation, 60000);

function clearLog() {
  try {
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(statusLogFile, '');
  } catch (e) {
    console.error('[LOGGER] Error clearing logs:', e.message);
  }
}

const NOISY_METHODS = [
  'Runtime.consoleAPICalled',
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.resourceChangedPriority',
  'Network.requestServedFromCache',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.eventSourceMessageReceived',
  'Input.dispatchMouseEvent',
  'Input.mouseMoved',
  'Input.keyDown',
  'Input.keyUp',
  'Input.char',
  'Input.dispatchKeyEvent',
  'Page.lifecycleEvent',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.frameNavigated',
  'Page.frameRequestedNavigation',
  'Page.frameScheduledNavigation',
  'Page.frameStartedNavigating',
  'Page.frameAttached',
  'Page.frameClearedScheduledNavigation',
  'Page.navigatedWithinDocument',
  'Page.domContentEventFired',
  'Page.loadEventFired',
  'Page.screencastFrame',
  'Page.screencastFrameAck',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Runtime.bindingCalled',
  'CSS.styleChanged',
  'CSS.fontsUpdated',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.childNodeCountUpdated',
  'Log.entryAdded',
];

function truncateMessage(message) {
  try {
    const parsed = JSON.parse(message);
    if (parsed.method === 'Page.screencastFrame' && parsed.params?.data) {
      const truncated = { ...parsed };
      truncated.params = { ...parsed.params };
      truncated.params.data = `[BASE64_IMAGE_${parsed.params.data.length}bytes]`;
      return JSON.stringify(truncated);
    }
    if (parsed.method === 'Page.screencastFrameAck') {
      const truncated = { ...parsed };
      truncated.params = { sessionId: parsed.params?.sessionId };
      return JSON.stringify(truncated);
    }
    if (NOISY_METHODS.includes(parsed.method)) {
      return null;
    }
    return message;
  } catch {
    return message;
  }
}

function logCDP(direction, message, sessionId = null, pluginType = null) {
  const truncatedMessage = truncateMessage(message);
  if (truncatedMessage === null) {
    return;
  }
  const timestamp = new Date().toISOString();
  const sessionPrefix = sessionId && typeof sessionId === 'string' ? `[session:${sessionId.substring(0, 8)}]` : '';
  const typePrefix = pluginType ? `[${pluginType}]` : '';
  const logLine = `[${timestamp}] ${typePrefix}${sessionPrefix}[${direction}] ${truncatedMessage}\n`;
  
  logWriteQueue.push(logLine);
  if (logWriteQueue.length > 100) {
    flushLogQueue();
  }
}

function logEvent(event, details) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [EVENT] ${event} ${details}\n`;
  
  logWriteQueue.push(logLine);
  if (logWriteQueue.length > 100) {
    flushLogQueue();
  }
}

function logStatus(status) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${JSON.stringify(status)}\n`;
  
  statusWriteQueue.push(logLine);
  if (statusWriteQueue.length > 100) {
    flushStatusQueue();
  }
}

function logConnectionEvent(event, data) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${event}] ${JSON.stringify(data)}\n`;
  
  statusWriteQueue.push(logLine);
  if (statusWriteQueue.length > 100) {
    flushStatusQueue();
  }
}

function flushAllLogs() {
  flushLogQueue();
  flushStatusQueue();
}

setInterval(flushAllLogs, 5000);

process.on('beforeExit', flushAllLogs);

module.exports = { 
  logCDP, 
  logEvent, 
  clearLog, 
  logFile, 
  logStatus, 
  logConnectionEvent,
  flushAllLogs
};
