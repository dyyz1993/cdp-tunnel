const CONFIG = {
  // 主端口：create 模式 + 扩展入口（/plugin）。
  // 同时是端口池的逻辑第 0 个端口（pool_{PORT}），与 POOL_START-POOL_START+POOL_SIZE-1 行为一致。
  PORT: process.env.PORT ? parseInt(process.env.PORT) : 9221,
  // takeover 唯一端口：接管用户已打开的 tab（不分组、断开不关 tab、全局仅一个连接）
  TAKEOVER_PORT: process.env.TAKEOVER_PORT ? parseInt(process.env.TAKEOVER_PORT) : 9220,
  // 端口池 create 端口范围（9231-9239），每个端口 = 一个独立隔离浏览器
  POOL_START: process.env.POOL_START ? parseInt(process.env.POOL_START) : 9231,
  POOL_SIZE: process.env.POOL_SIZE ? parseInt(process.env.POOL_SIZE) : 9,
  // 端口池的 takeover 端口（与 TAKEOVER_PORT 同值，由端口池的 _startTakeoverPort 实际监听）
  POOL_TAKEOVER_PORT: process.env.POOL_TAKEOVER_PORT ? parseInt(process.env.POOL_TAKEOVER_PORT) : 9220,
  HEARTBEAT_INTERVAL: 30000,
  STATUS_PRINT_INTERVAL: 60000,
  TARGETS_CACHE_TTL: 2000,
  TARGETS_REQUEST_TIMEOUT: 1000,
  CDP_TRACE_MAX_LENGTH: 300,
  LOG_MESSAGE_PREVIEW_LENGTH: 1000,
  CLIENT_IDLE_TIMEOUT: 300000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  AUTO_RESTART: process.env.AUTO_RESTART === 'true',
  CHROME_RESTART_COOLDOWN: 30000,
  PLUGIN_MAX_MISSED_PINGS: 3
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
