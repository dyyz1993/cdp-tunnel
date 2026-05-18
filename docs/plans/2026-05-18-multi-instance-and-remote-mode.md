# CDP Tunnel 多实例 + 远程模式 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 支持 2 种使用模式：(1) 插件直连远程 WS（无本地 Node），(2) 本地多实例（多端口多 Chrome 并行）

**Architecture:** 按端口隔离实例目录 `~/.cdp-tunnel/instances/{port}/`，CLI 所有命令增加 `-p` 参数支持指定实例。新增 `cdp-tunnel remote` 命令输出远程连接指引。Server 端 extension-state 写入实例目录。插件端已有 `chrome.storage.local` 的 `wsAddress` 配置，无需大改。

**Tech Stack:** Node.js, Commander.js, Chrome Extension (Manifest V3), WebSocket (ws)

---

## 模式说明

### 模式1：插件 → 远程 WS（无本地 Node）
- 用户不启动本地 server
- 在插件配置页直接填写远程 WS 地址（如 `wss://remote.example.com/plugin`）
- 插件直连远程，CDP 全部由远程服务器接管
- CLI 提供 `cdp-tunnel remote` 命令生成配置指引

### 模式2：插件 → 本地 Node 服务（多实例）
- `cdp-tunnel start -p 9221` 启动实例1
- `cdp-tunnel start -p 9222` 启动实例2
- 每个 Chrome Profile 的插件配对应端口的 `wsAddress`
- `cdp-tunnel status` 显示所有实例
- `cdp-tunnel stop -p 9221` 停止指定实例

---

## 目录结构变更

```
~/.cdp-tunnel/
├── config.json                 # 全局配置（保留，存默认端口等）
├── instances/
│   ├── 9221/
│   │   ├── server.pid
│   │   ├── config.json         # 实例配置 { port, autoRestart }
│   │   ├── extension-state.json
│   │   ├── plugin-ever-connected
│   │   └── server.log
│   └── 9222/
│       ├── server.pid
│       ├── config.json
│       ├── extension-state.json
│       ├── plugin-ever-connected
│       └── server.log
└── guide.html                  # 全局，仅一份
```

---

### Task 1: 重构 CLI 文件路径管理 — 引入实例目录

**Files:**
- Modify: `cli/index.js:9-14` (常量定义区)
- Modify: `cli/index.js:51-84` (配置读写函数)

**Step 1: 添加实例目录辅助函数**

在 `cli/index.js` 常量区后添加：

```javascript
const INSTANCES_DIR = path.join(CONFIG_DIR, 'instances');

function getInstanceDir(port) {
  return path.join(INSTANCES_DIR, port.toString());
}

function getInstanceFilePath(port, filename) {
  return path.join(getInstanceDir(port), filename);
}

function ensureInstanceDir(port) {
  const dir = getInstanceDir(port);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
```

**Step 2: 重构配置/状态函数为端口参数化**

将以下函数改为接受 `port` 参数：

```javascript
function getConfig(port) {
  const file = port ? getInstanceFilePath(port, 'config.json') : CONFIG_FILE;
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return { port: port || 9221 };
}

function saveConfig(config, port) {
  const file = port ? getInstanceFilePath(port, 'config.json') : CONFIG_FILE;
  const dir = port ? getInstanceDir(port) : CONFIG_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

function isServerRunning(port) {
  const pidFile = port ? getInstanceFilePath(port, 'server.pid') : PID_FILE;
  if (!fs.existsSync(pidFile)) return false;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.unlinkSync(pidFile);
    return false;
  }
}

function getServerPid(port) {
  const pidFile = port ? getInstanceFilePath(port, 'server.pid') : PID_FILE;
  if (!fs.existsSync(pidFile)) return null;
  return parseInt(fs.readFileSync(pidFile, 'utf8'));
}

function checkChromeExtension(port) {
  const stateFile = port ? getInstanceFilePath(port, 'extension-state.json') : EXTENSION_STATE_FILE;
  if (!fs.existsSync(stateFile)) {
    return { installed: false };
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const timeDiff = Math.abs(Date.now() - state.lastSeen);
    if (state.connected && timeDiff < 300000) {
      return { installed: true, connected: true };
    }
    return { installed: true, connected: false };
  } catch (e) {
    return { installed: false };
  }
}
```

**Step 3: 验证**

运行 `cdp-tunnel status` 确认向后兼容（无 -p 参数时使用全局文件）。

---

### Task 2: 重构 `startServer()` 为多实例支持

**Files:**
- Modify: `cli/index.js:164-243` (startServer 函数)

**Step 1: startServer 增加 port 参数，PID/log 写入实例目录**

```javascript
function startServer(port, watchdog, autoRestart) {
  ensureInstanceDir(port);
  const instancePidFile = getInstanceFilePath(port, 'server.pid');
  const instanceLogFile = getInstanceFilePath(port, 'server.log');
  const serverPath = path.join(__dirname, '..', 'server', 'proxy-server.js');

  // 清理日志（同原逻辑，用实例目录文件）
  cleanupLogFile(instanceLogFile);

  const logFd = fs.openSync(instanceLogFile, 'a');
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: port.toString(),
      AUTO_RESTART: autoRestart ? 'true' : 'false'
    }
  });
  child.unref();
  fs.writeFileSync(instancePidFile, child.pid.toString());

  if (watchdog) {
    let restartCount = 0;
    let restartWindow = Date.now();
    child.on('exit', () => {
      const now = Date.now();
      if (now - restartWindow > 60000) {
        restartCount = 0;
        restartWindow = now;
      }
      restartCount++;
      if (restartCount > 10) {
        // 日志写实例目录
        fs.appendFileSync(instanceLogFile, `[${new Date().toISOString()}] Too many restarts, giving up\n`);
        return;
      }
      // 清理残留端口
      try {
        const result = execSync(`lsof -ti:${port} 2>/dev/null || true`).toString().trim();
        if (result) {
          const pids = result.split('\n').filter(p => p && parseInt(p) !== process.pid);
          pids.forEach(pid => {
            try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
          });
        }
      } catch {}
      setTimeout(() => startServer(port, true, autoRestart), 5000);
    });
  }
}
```

**Step 2: cleanupLogFile 改为接受文件路径参数**

```javascript
function cleanupLogFile(logFilePath) {
  if (!fs.existsSync(logFilePath)) return;
  const stats = fs.statSync(logFilePath);
  if (stats.size > MAX_LOG_SIZE) {
    fs.truncateSync(logFilePath, 0);
  }
}
```

---

### Task 3: 重构 `start` 命令

**Files:**
- Modify: `cli/index.js:278-375` (start 命令)

**Step 1: start 命令使用实例目录**

```javascript
program
  .command('start')
  .description('启动 CDP Tunnel 服务器')
  .option('-p, --port <port>', '指定端口', parseInt)
  .option('-w, --watchdog', '启用看门狗')
  .option('-a, --auto-restart', '浏览器断连时自动重启 Chrome')
  .action(async (options) => {
    const globalConfig = getConfig(); // 读全局配置取默认端口
    const port = options.port || globalConfig.port || 9221;
    const instanceConfig = getConfig(port);

    instanceConfig.port = port;
    instanceConfig.autoRestart = !!options.autoRestart;
    saveConfig(instanceConfig, port);

    if (isServerRunning(port)) {
      console.log('');
      log('yellow', `⚠ 服务器已在运行 (PID: ${getServerPid(port)}, 端口: ${port})`);
      log('cyan', `  CDP: http://localhost:${port}`);
    } else {
      ensureInstanceDir(port);
      startServer(port, options.watchdog, options.autoRestart);
      console.log('');
      log('green', '✅ 服务器已启动');
      log('cyan', `  端口:   ${port}`);
      log('cyan', `  CDP:    http://localhost:${port}`);
      log('cyan', `  Plugin: ws://localhost:${port}/plugin`);
    }

    await new Promise(r => setTimeout(r, 1000));

    const extStatus = checkChromeExtension(port);
    // ... 后续扩展检测逻辑同原代码，但 checkChromeExtension 传入 port
  });
```

---

### Task 4: 重构 `stop` 命令

**Files:**
- Modify: `cli/index.js:377-394` (stop 命令)

**Step 1: stop 支持 -p 参数和 --all**

```javascript
program
  .command('stop')
  .description('停止 CDP Tunnel 服务器')
  .option('-p, --port <port>', '指定端口', parseInt)
  .option('--all', '停止所有实例')
  .action((options) => {
    if (options.all) {
      // 扫描 instances 目录下所有子目录
      if (!fs.existsSync(INSTANCES_DIR)) {
        log('yellow', '⚠️  没有运行中的实例');
        return;
      }
      const ports = fs.readdirSync(INSTANCES_DIR).filter(dir => {
        return fs.existsSync(getInstanceFilePath(dir, 'server.pid'));
      });
      if (ports.length === 0) {
        log('yellow', '⚠️  没有运行中的实例');
        return;
      }
      ports.forEach(p => {
        const port = parseInt(p);
        if (isServerRunning(port)) {
          const pid = getServerPid(port);
          try {
            process.kill(pid, 'SIGTERM');
            fs.unlinkSync(getInstanceFilePath(port, 'server.pid'));
            log('green', `✓ 端口 ${port} 已停止 (PID: ${pid})`);
          } catch (e) {
            log('red', `✗ 端口 ${port} 停止失败: ${e.message}`);
          }
        }
      });
      return;
    }

    const globalConfig = getConfig();
    const port = options.port || globalConfig.port || 9221;

    if (!isServerRunning(port)) {
      log('yellow', `⚠️  服务器未运行 (端口: ${port})`);
      return;
    }

    const pid = getServerPid(port);
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(getInstanceFilePath(port, 'server.pid'));
      log('green', `✓ 服务器已停止 (端口: ${port})`);
    } catch (e) {
      log('red', '✗ 停止服务器失败: ' + e.message);
    }
  });
```

---

### Task 5: 重构 `status` 命令 — 支持显示所有实例

**Files:**
- Modify: `cli/index.js:481-516` (status 命令)

**Step 1: status 无参数显示所有实例，有 -p 显示指定实例**

```javascript
program
  .command('status')
  .description('查看服务器状态')
  .option('-p, --port <port>', '指定端口', parseInt)
  .action((options) => {
    console.log('');
    console.log('CDP Tunnel 状态');
    console.log('─'.repeat(30));

    if (options.port) {
      // 显示指定实例
      printInstanceStatus(options.port);
    } else {
      // 显示所有实例
      let foundAny = false;

      // 兼容旧的单实例（PID_FILE 还在根目录）
      if (fs.existsSync(PID_FILE) && !fs.existsSync(INSTANCES_DIR)) {
        printInstanceStatus(null);
        foundAny = true;
      } else if (fs.existsSync(INSTANCES_DIR)) {
        const ports = fs.readdirSync(INSTANCES_DIR);
        if (ports.length > 0) {
          ports.forEach(p => {
            printInstanceStatus(parseInt(p));
            foundAny = true;
          });
        }
      }

      if (!foundAny) {
        const globalConfig = getConfig();
        console.log('');
        log('yellow', '  没有运行中的实例');
        log('gray', `  默认端口: ${globalConfig.port || 9221}`);
        log('cyan', '  启动: cdp-tunnel start [-p 端口]');
      }
    }
    console.log('');
  });

function printInstanceStatus(port) {
  const config = port ? getConfig(port) : getConfig();
  const p = port || config.port || 9221;
  const running = isServerRunning(p);
  const pid = running ? getServerPid(p) : null;
  const extStatus = checkChromeExtension(p);

  console.log('');
  console.log(`  实例 [端口 ${p}]`);
  console.log('  ' + '─'.repeat(20));
  console.log('  服务器: ' + (running ? '\x1b[32m运行中\x1b[0m' : '\x1b[31m已停止\x1b[0m'));
  if (running) {
    console.log('  PID:    ' + pid);
    console.log('  CDP:    http://localhost:' + p);
  }

  if (extStatus.installed && extStatus.connected) {
    console.log('  扩展:   \x1b[32m已连接\x1b[0m');
  } else if (extStatus.installed) {
    console.log('  扩展:   \x1b[33m已安装但未连接\x1b[0m');
  }
}
```

---

### Task 6: 新增 `remote` 命令

**Files:**
- Modify: `cli/index.js` (新增命令)

**Step 1: 添加 remote 命令**

```javascript
program
  .command('remote')
  .description('查看远程连接配置指引')
  .option('-s, --server <url>', '远程服务器地址，如 wss://example.com/plugin')
  .action((options) => {
    console.log('');
    log('cyan', '📡 CDP Tunnel 远程模式配置指引');
    console.log('─'.repeat(40));
    console.log('');

    if (options.server) {
      log('green', '✅ 远程服务器: ' + options.server);
    } else {
      log('yellow', '⚠  未指定远程地址');
      log('gray', '  用法: cdp-tunnel remote -s wss://your-server.com/plugin');
    }

    console.log('');
    log('bold', '  配置步骤:');
    console.log('');
    console.log('  1. 安装 CDP Bridge 扩展到 Chrome');
    console.log('     → 运行: cdp-tunnel extension');
    console.log('');
    console.log('  2. 点击浏览器工具栏的 CDP Bridge 图标');
    console.log('');
    if (options.server) {
      console.log('  3. 在 "Server Address" 输入框中填入:');
      log('green', `     ${options.server}`);
    } else {
      console.log('  3. 在 "Server Address" 输入框中填入远程 WS 地址');
    }
    console.log('');
    console.log('  4. 点击 "Save & Connect"');
    console.log('');
    console.log('  5. 在远程服务器上运行 Playwright:');
    if (options.server) {
      const httpUrl = options.server
        .replace('wss://', 'https://')
        .replace('ws://', 'http://')
        .replace(/\/plugin$/, '');
      console.log(`     chromium.connectOverCDP('${httpUrl}')`);
    } else {
      console.log('     chromium.connectOverCDP("http://your-server:port")');
    }
    console.log('');
    log('gray', '  注意: 此模式不需要启动本地 cdp-tunnel server');
    console.log('');
  });
```

---

### Task 7: 重构 Server — extension-state 写入实例目录

**Files:**
- Modify: `server/proxy-server.js:22-24` (文件路径常量)
- Modify: `server/proxy-server.js:125-135` (updateExtensionState 函数)

**Step 1: Server 端路径按端口区分**

```javascript
// server/proxy-server.js 头部常量替换
const PORT = CONFIG.PORT;
const CONFIG_DIR = path.join(os.homedir(), '.cdp-tunnel');
const INSTANCE_DIR = path.join(CONFIG_DIR, 'instances', PORT.toString());

// 确保实例目录存在
if (!fs.existsSync(INSTANCE_DIR)) {
    fs.mkdirSync(INSTANCE_DIR, { recursive: true });
}

const EXTENSION_STATE_FILE = path.join(INSTANCE_DIR, 'extension-state.json');
const PLUGIN_EVER_CONNECTED_FILE = path.join(INSTANCE_DIR, 'plugin-ever-connected');
```

**Step 2: updateExtensionState 保持不变**

它已经引用 `EXTENSION_STATE_FILE`，路径变了就自动写入实例目录。

---

### Task 8: 重构 `restart` 和 `update` 命令

**Files:**
- Modify: `cli/index.js` (restart 逻辑，如有)
- Modify: `cli/index.js:396-460` (update 命令)

**Step 1: update 命令支持 -p**

在 update 命令的 `.action` 中，使用 `options.port` 确定目标实例：

```javascript
.action(async (options) => {
    const globalConfig = getConfig();
    const port = options.port || globalConfig.port || 9221;
    const wasRunning = isServerRunning(port);
    const savedConfig = getConfig(port);
    // ... 后续同原逻辑，所有 isServerRunning/getServerPid 传入 port
```

---

### Task 9: 兼容性迁移 — 首次运行时迁移旧文件

**Files:**
- Modify: `cli/index.js` (在 ensureConfigDir 之后添加迁移逻辑)

**Step 1: 添加自动迁移函数**

```javascript
function migrateFromLegacy() {
  // 如果旧 PID 文件存在但 instances 目录不存在，迁移
  const legacyPid = PID_FILE;
  const legacyExtState = EXTENSION_STATE_FILE;

  if (!fs.existsSync(legacyPid) && !fs.existsSync(legacyExtState)) return;

  // 读取旧的 config.json 获取端口
  const oldConfig = getConfig();
  const port = oldConfig.port || 9221;

  // 如果 instances 目录已存在该端口，跳过
  if (fs.existsSync(getInstanceDir(port))) return;

  ensureInstanceDir(port);

  // 迁移文件
  try {
    if (fs.existsSync(legacyPid)) {
      fs.copyFileSync(legacyPid, getInstanceFilePath(port, 'server.pid'));
      fs.unlinkSync(legacyPid);
    }
    if (fs.existsSync(legacyExtState)) {
      fs.copyFileSync(legacyExtState, getInstanceFilePath(port, 'extension-state.json'));
      fs.unlinkSync(legacyExtState);
    }
    // 迁移 config
    saveConfig(oldConfig, port);

    log('gray', `  已迁移旧配置到实例目录 (端口: ${port})`);
  } catch (e) {
    // 迁移失败不影响使用
  }
}
```

在 `ensureConfigDir()` 调用之后调用 `migrateFromLegacy()`。

---

### Task 10: 验证测试

**Step 1: 测试模式2 — 本地多实例**

```bash
# 启动两个实例
cdp-tunnel start -p 9221
cdp-tunnel start -p 9222

# 查看状态（应显示两个实例）
cdp-tunnel status

# 停止其中一个
cdp-tunnel stop -p 9221

# 确认另一个还在运行
cdp-tunnel status

# 停止全部
cdp-tunnel stop --all
```

**Step 2: 测试模式1 — 远程指引**

```bash
cdp-tunnel remote -s wss://example.com/plugin
# 应输出配置步骤
```

**Step 3: 测试兼容性**

```bash
# 不带 -p 参数的 start 应使用默认端口 9221
cdp-tunnel start
cdp-tunnel status
cdp-tunnel stop
```

**Step 4: 测试旧文件迁移**

```bash
# 手动创建旧格式文件，然后运行 status 检查是否自动迁移
```

---

## 文件改动汇总

| 文件 | 改动 | 复杂度 |
|---|---|---|
| `cli/index.js` | 新增实例目录函数 + 重构所有命令 + 新增 remote 命令 + 迁移逻辑 | 高 |
| `server/proxy-server.js` | EXTENSION_STATE_FILE 路径改为实例目录 | 低 |
| `server/modules/config.js` | 无需改动（PORT 已通过 env 传入） | 无 |
| `extension-new/*` | 无需改动（已支持 chrome.storage.local 自由配置 wsAddress） | 无 |
