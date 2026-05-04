const CONFIG = {
  PORT: process.env.PORT ? parseInt(process.env.PORT) : 9221,
  HEARTBEAT_INTERVAL: 30000,
  STATUS_PRINT_INTERVAL: 60000,
  TARGETS_CACHE_TTL: 2000,
  TARGETS_REQUEST_TIMEOUT: 1000,
  CDP_TRACE_MAX_LENGTH: 300,
  LOG_MESSAGE_PREVIEW_LENGTH: 1000,
  CLIENT_IDLE_TIMEOUT: 300000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function shouldLog(level) {
  const currentLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] ?? LOG_LEVELS.info;
  const targetLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return targetLevel >= currentLevel;
}

const BROWSER_ID = `browser_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

module.exports = { CONFIG, BROWSER_ID, shouldLog };
