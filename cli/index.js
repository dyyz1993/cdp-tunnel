#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.cdp-tunnel');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'server.log');
const EXTENSION_STATE_FILE = path.join(CONFIG_DIR, 'extension-state.json');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

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

const program = new Command();

program
  .name('cdp-tunnel')
  .description('Chrome DevTools Protocol Tunnel')
  .version(require(path.join(__dirname, '..', 'package.json')).version);

function syncExtensionVersion() {
  try {
    const pkgVersion = require(path.join(__dirname, '..', 'package.json')).version;
    const manifestPath = path.join(__dirname, '..', 'extension-new', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== pkgVersion) {
      manifest.version = pkgVersion;
      manifest.description = `CDP Tunnel v${pkgVersion} — ${manifest.description.split('—')[1] || manifest.description}`.trim();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
  } catch {}
}

syncExtensionVersion();

function log(color, ...args) {
  const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m',
    reset: '\x1b[0m'
  };
  console.log(colors[color] || '', ...args, colors.reset);
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function cleanupLogFile(logFilePath) {
  try {
    if (!fs.existsSync(logFilePath)) return;
    const stats = fs.statSync(logFilePath);
    if (stats.size > MAX_LOG_SIZE) {
      fs.writeFileSync(logFilePath, '');
      console.log('');
      log('yellow', '⚠ 日志文件超过 10MB，已清空');
      console.log('');
    }
  } catch (e) {
    // 清理失败不影响启动
  }
}

function getConfig(port) {
  ensureConfigDir();
  const file = port ? getInstanceFilePath(port, 'config.json') : CONFIG_FILE;
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return { port: port || 9221 };
}

function saveConfig(config, port) {
  ensureConfigDir();
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

function getExtensionPath() {
  if (process.env.CDP_TUNNEL_DEV_EXT) {
    return process.env.CDP_TUNNEL_DEV_EXT;
  }
  const cliDir = __dirname;
  return path.join(cliDir, '..', 'extension-new');
}

function printExtensionGuide() {
  const extPath = getExtensionPath();
  
  console.log('');
  log('yellow', '❌ Chrome 扩展未安装');
  console.log('');
  log('bold', '请按以下步骤安装：');
  console.log('');
  log('cyan', '  1.'), console.log(' 已自动打开 Chrome 扩展页面');
  log('cyan', '  2.'), console.log(' 开启右上角「开发者模式」');
  log('cyan', '  3.'), console.log(' 点击「加载已解压的扩展程序」');
  log('cyan', '  4.'), console.log(' 选择以下目录：');
  console.log('');
  log('gray', '    ' + extPath);
  console.log('');
  log('cyan', '  5.'), console.log(' 安装完成后，点击扩展图标连接服务器');
  console.log('');
}

function openChromeExtensions() {
  const platform = os.platform();
  
  try {
    if (platform === 'darwin') {
      execSync('open "chrome://extensions/"');
    } else if (platform === 'win32') {
      execSync('start chrome://extensions/');
    } else {
      execSync('xdg-open "chrome://extensions/"');
    }
  } catch (e) {
    console.log('请手动打开: chrome://extensions/');
  }
}

function startServer(port, watchdog, autoRestart) {
  ensureInstanceDir(port);
  const instancePidFile = getInstanceFilePath(port, 'server.pid');
  const instanceLogFile = getInstanceFilePath(port, 'server.log');
  const serverPath = path.join(__dirname, '..', 'server', 'proxy-server.js');

  cleanupLogFile(instanceLogFile);

  const logFd = fs.openSync(instanceLogFile, 'a');

  const child = spawn(process.execPath, [serverPath], {
    detached: !watchdog,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: port.toString(), AUTO_RESTART: autoRestart ? 'true' : 'false' }
  });

  fs.writeFileSync(instancePidFile, child.pid.toString());

  if (watchdog) {
    let restartCount = 0;
    const MAX_RESTARTS = 10;
    const RESTART_WINDOW = 60000;
    let restartTimestamps = [];

    child.on('exit', (code, signal) => {
      const now = Date.now();
      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      const logLine = `[${new Date().toISOString()}] [WATCHDOG] 服务器退出: ${reason}\n`;
      fs.appendFileSync(instanceLogFile, logLine);

      if (code === 0 && !signal) {
        log('gray', '  服务器正常退出 (code=0)，不重启');
        try { fs.unlinkSync(instancePidFile); } catch {}
        process.exit(0);
      }

      restartTimestamps = restartTimestamps.filter(t => now - t < RESTART_WINDOW);
      restartTimestamps.push(now);

      if (restartTimestamps.length > MAX_RESTARTS) {
        console.log('');
        log('red', '✗ 服务器在 60 秒内崩溃超过 ' + MAX_RESTARTS + ' 次，停止重启');
        log('gray', '  请检查日志: ' + instanceLogFile);
        console.log('');
        try { fs.unlinkSync(instancePidFile); } catch {}
        process.exit(1);
      }

      console.log('');
      log('yellow', '⚠ 服务器异常退出 (' + reason + ')，5 秒后自动重启...');
      console.log('  重启次数: ' + restartTimestamps.length + '/' + MAX_RESTARTS + ' (60秒内)');
      console.log('');

      try {
        const result = execSync(`lsof -ti:${port} 2>/dev/null || true`).toString().trim();
        if (result) {
          const pids = result.split('\n').filter(p => p && parseInt(p) !== process.pid);
          pids.forEach(p => { try { process.kill(parseInt(p), 'SIGKILL'); } catch {} });
          if (pids.length > 0) {
            log('gray', '  已清理占用端口 ' + port + ' 的残留进程: ' + pids.join(', '));
          }
        }
      } catch {}

      setTimeout(() => startServer(port, true, autoRestart), 5000);
    });

    process.on('SIGINT', () => {
      console.log('');
      log('cyan', '正在停止服务器（含 watchdog）...');
      try { child.kill('SIGTERM'); } catch {}
      try { fs.unlinkSync(instancePidFile); } catch {}
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      try { child.kill('SIGTERM'); } catch {}
      try { fs.unlinkSync(instancePidFile); } catch {}
      process.exit(0);
    });
  } else {
    child.unref();
  }

  return child;
}

function waitForPluginConnection(port, maxWaitMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const status = checkChromeExtension(port);
      if (status.connected) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start > maxWaitMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 3000);
  });
}

function generateAndSaveGuideHtml() {
  return generateGuideHtml();
}

function openInBrowser(filePath) {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      execSync(`open "${filePath}"`);
    } else if (platform === 'win32') {
      execSync(`start "" "${filePath}"`);
    } else {
      execSync(`xdg-open "${filePath}"`);
    }
  } catch {}
}

program
  .command('start')
  .description('启动 CDP Tunnel 服务器')
  .option('-p, --port <port>', '指定端口', parseInt)
  .option('-w, --watchdog', '启用看门狗，服务器崩溃时自动重启')
  .option('-a, --auto-restart', '浏览器断连时自动重启 Chrome（带插件）')
  .action(async (options) => {
    const globalConfig = getConfig();
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
    if (extStatus.connected) {
      console.log('');
      log('green', '✅ Ready! Chrome 扩展已连接');
      log('cyan', `  连接: ws://localhost:${port}/devtools/browser/...`);
      if (!options.watchdog) {
        process.exit(0);
      }
      return;
    }

    const { isChromeRunning, launchChromeWithExtension } = require('./chrome-manager');
    const chromeRunning = isChromeRunning();

    if (!chromeRunning) {
      log('cyan', '🔍 Chrome 未运行，正在启动...');
      const launched = launchChromeWithExtension();
      if (launched) {
        log('cyan', '⏳ 等待插件连接...');
        const connected = await waitForPluginConnection(port, 15000);
        if (connected) {
          console.log('');
          log('green', '✅ Ready! Chrome 已启动，插件已连接');
          log('cyan', `  连接: ws://localhost:${port}/devtools/browser/...`);
        } else {
          console.log('');
          log('yellow', '⚠ Chrome 已启动，但插件未自动连接。请点击浏览器工具栏上的 CDP Bridge 图标。');
        }
      } else {
        console.log('');
        log('yellow', '⚠ 无法自动启动 Chrome。请手动安装插件：');
        printExtensionGuide();
        openChromeExtensions();
        const connected = await waitForPluginConnection(port, 120000);
        if (connected) {
          console.log('');
          log('green', '✅ Ready! 插件已连接');
          log('cyan', `  连接: ws://localhost:${port}/devtools/browser/...`);
        } else {
          console.log('');
          log('yellow', '⚠ 等待超时。插件安装完成后，运行 cdp-tunnel start 即可。');
        }
      }
      if (!options.watchdog) process.exit(0);
      return;
    }

    console.log('');
    log('yellow', '⚠ Chrome 正在运行但插件未连接');
    log('cyan', '📖 正在打开安装引导...');

    const guidePath = generateAndSaveGuideHtml();
    openInBrowser(guidePath);
    openChromeExtensions();
    printExtensionGuide();

    log('cyan', '⏳ 等待插件安装并连接（最多 2 分钟）...');
    const connected = await waitForPluginConnection(port, 120000);
    if (connected) {
      console.log('');
      log('green', '✅ Ready! 插件已连接');
      log('cyan', `  连接: ws://localhost:${port}/devtools/browser/...`);
    } else {
      console.log('');
      log('yellow', '⚠ 等待超时。插件安装完成后，运行 cdp-tunnel start 即可。');
    }

    if (!options.watchdog) process.exit(0);
  });

program
  .command('stop')
  .description('停止 CDP Tunnel 服务器')
  .option('-p, --port <port>', '指定端口', parseInt)
  .option('--all', '停止所有实例')
  .action((options) => {
    if (options.all) {
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

program
  .command('update')
  .description('自动更新 cdp-tunnel 并重启服务')
  .option('-p, --port <port>', '指定端口', parseInt)
  .option('-w, --watchdog', '启用看门狗')
  .action(async (options) => {
    const globalConfig = getConfig();
    const port = options.port || globalConfig.port || 9221;
    const wasRunning = isServerRunning(port);
    const savedConfig = getConfig(port);
    const savedWatchdog = options.watchdog;
    
    try {
      log('cyan', '🔍 检查更新...');
      let latestVersion;
      try {
        latestVersion = execSync('npm view cdp-tunnel version', { 
          encoding: 'utf8', 
          timeout: 30000
        }).trim();
      } catch (err) {
        log('red', '❌ 无法连接 npm registry: ' + err.message);
        process.exit(1);
      }
      
      const localVersion = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'package.json'), 'utf8'
      )).version;
      
      log('gray', '  当前版本: ' + localVersion);
      log('gray', '  最新版本: ' + latestVersion);
      
      if (localVersion === latestVersion) {
        log('green', '✅ 已是最新版本 (' + localVersion + ')');
        if (wasRunning) {
          log('cyan', '  服务器仍在运行中 (端口: ' + port + ')');
        }
        process.exit(0);
      }
      
      if (wasRunning) {
        log('yellow', '⏸ 停止服务器 (端口: ' + port + ')...');
        const pid = getServerPid(port);
        if (pid) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      
      log('cyan', '📦 更新中 (' + localVersion + ' → ' + latestVersion + ')...');
      try {
        execSync('npm install -g cdp-tunnel@latest', { 
          stdio: 'inherit',
          cwd: __dirname
        });
      } catch (err) {
        log('red', '❌ 更新失败: ' + err.message);
        process.exit(1);
      }
      
      const newVersion = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'package.json'), 'utf8'
      )).version;
      
      if (newVersion !== localVersion) {
        log('green', '✅ 已更新: ' + localVersion + ' → ' + newVersion);
      } else {
        log('yellow', '⚠ 版本未变化，可能需要手动更新');
      }
      
      if (wasRunning) {
        log('cyan', '🔄 重启服务器 (端口: ' + port + ')...');
        const child = startServer(port, false, savedConfig.autoRestart);
        child.unref();
        log('green', '✅ 服务器已重启 (PID: ' + child.pid + ', 端口: ' + port + ')');
      } else {
        log('cyan', '  运行 cdp-tunnel start 启动服务器');
      }
      
      process.exit(0);
    } catch (err) {
      log('red', '❌ 更新出错: ' + err.message);
      process.exit(1);
    }
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

program
  .command('status')
  .description('查看服务器状态')
  .option('-p, --port <port>', '指定端口', parseInt)
  .action((options) => {
    console.log('');
    console.log('CDP Tunnel 状态');
    console.log('─'.repeat(30));

    if (options.port) {
      printInstanceStatus(options.port);
    } else {
      let foundAny = false;

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

function generateGuideHtml() {
  const extensionPath = path.join(__dirname, '..', 'extension-new');
  const realPath = fs.realpathSync(extensionPath);
  
  const templatePath = path.join(__dirname, 'guide.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  
  // 替换路径占位符
  html = html.replace(
    /{{EXTENSION_PATH}}/g,
    realPath
  );
  
  // 生成临时 HTML 文件
  const tempHtmlPath = path.join(CONFIG_DIR, 'guide.html');
  ensureConfigDir();
  fs.writeFileSync(tempHtmlPath, html);
  
  // 复制 icon 文件到同一目录
  const iconSource = path.join(__dirname, 'icon128.png');
  const iconTarget = path.join(CONFIG_DIR, 'icon128.png');
  if (fs.existsSync(iconSource)) {
    fs.copyFileSync(iconSource, iconTarget);
  }
  
  return tempHtmlPath;
}

program
  .command('extension')
  .description('检测/安装 Chrome 扩展')
  .action(() => {
    const extStatus = checkChromeExtension();
    
    if (extStatus.installed && extStatus.connected) {
      log('green', '✓ Chrome 扩展已连接');
      return;
    }
    
    if (extStatus.installed) {
      log('yellow', '⚠️  扩展已安装但未连接');
      console.log('正在打开连接指南...');
      
      const guidePath = generateGuideHtml();
      const platform = os.platform();
      
      try {
        if (platform === 'darwin') {
          execSync('open "' + guidePath + '"');
        } else if (platform === 'win32') {
          execSync('start "" "' + guidePath + '"');
        } else {
          execSync('xdg-open "' + guidePath + '"');
        }
        console.log('已打开连接指南页面');
      } catch (e) {
        console.log('请手动打开: ' + guidePath);
      }
      return;
    }
    
    // 扩展未安装，生成指南并打开
    console.log('');
    log('yellow', '⚠️  Chrome 扩展未安装');
    console.log('');
    console.log('正在打开安装指南...');
    
    const guidePath = generateGuideHtml();
    const platform = os.platform();
    
    try {
      if (platform === 'darwin') {
        execSync('open "' + guidePath + '"');
      } else if (platform === 'win32') {
        execSync('start "" "' + guidePath + '"');
      } else {
        execSync('xdg-open "' + guidePath + '"');
      }
      console.log('已打开安装指南页面');
    } catch (e) {
      console.log('请手动打开: ' + guidePath);
    }
  });

program
  .command('config')
  .description('配置管理')
  .argument('<action>', 'get/set')
  .argument('[key]', '配置项')
  .argument('[value]', '配置值')
  .action((action, key, value) => {
    const config = getConfig();
    
    if (action === 'get') {
      if (key) {
        console.log(config[key] || '');
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
    } else if (action === 'set') {
      if (!key || value === undefined) {
        console.log('用法: cdp-tunnel config set <key> <value>');
        console.log('示例: cdp-tunnel config set port 9221');
        return;
      }
      
      if (key === 'port') {
        config[key] = parseInt(value);
      } else {
        config[key] = value;
      }
      
      saveConfig(config);
      log('green', '✓ 已保存: ' + key + ' = ' + config[key]);
    } else {
      console.log('用法: cdp-tunnel config <get|set> [key] [value]');
    }
  });

program
  .command('diagnose')
  .description('诊断 CDP Tunnel 连接问题')
  .option('-p, --port <port>', '指定端口', parseInt)
  .action(async (options) => {
    const globalConfig = getConfig();
    const port = options.port || globalConfig.port || 9221;
    const http = require('http');

    console.log('');
    log('bold', '🔍 CDP Tunnel 诊断');
    console.log('');

    const running = isServerRunning(port);
    log(running ? 'green' : 'red', `  1. Proxy Server: ${running ? '运行中' : '❌ 未运行'}`);
    if (!running) {
      log('yellow', '     → 运行 cdp-tunnel start 启动服务器');
    }

    let httpOk = false;
    try {
      const result = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });
      httpOk = true;
      log('green', `  2. HTTP 端点: 正常 (Browser: ${result.Browser || 'unknown'})`);
    } catch (err) {
      log('red', `  2. HTTP 端点: ❌ ${err.message}`);
    }

    const extStatus = checkChromeExtension(port);
    log(extStatus.connected ? 'green' : 'red', `  3. Chrome 扩展: ${extStatus.connected ? '已连接' : '❌ 未连接'}`);
    if (!extStatus.connected) {
      log('yellow', '     → 点击浏览器工具栏上的 CDP Bridge 图标');
      log('yellow', '     → 或运行 cdp-tunnel extension 安装扩展');
    }

    if (httpOk) {
      try {
        const targets = await new Promise((resolve, reject) => {
          http.get(`http://localhost:${port}/json/list`, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
          }).on('error', reject);
        });
        log('green', `  4. 可用 Targets: ${targets.length} 个`);
        targets.forEach((t, i) => {
          log('gray', `     ${i + 1}. ${t.title || t.url || 'unknown'} (${t.type})`);
        });
      } catch (err) {
        log('red', `  4. Targets: ❌ ${err.message}`);
      }
    }

    const { isChromeRunning, findChromePath } = require('./chrome-manager');
    const chromeRunning = isChromeRunning();
    log(chromeRunning ? 'green' : 'yellow', `  5. Chrome 进程: ${chromeRunning ? '运行中' : '未运行'}`);

    if (chromeRunning) {
      const chromePath = findChromePath();
      if (chromePath) {
        log('gray', `     路径: ${chromePath}`);
      }
    }

    if (httpOk && extStatus.connected) {
      log('cyan', '  6. Playwright 连接测试...');
      try {
        const { chromium } = require('playwright');
        const browser = await chromium.connectOverCDP(`http://localhost:${port}`, {
          timeout: 10000
        });
        const contexts = browser.contexts();
        log('green', `     ✅ 连接成功! ${contexts.length} 个上下文, 共 ${contexts.reduce((sum, ctx) => sum + ctx.pages().length, 0)} 个页面`);
        await browser.close();
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          log('gray', '     ⏭ 跳过 (playwright 未安装)');
        } else {
          log('red', `     ❌ ${err.message}`);
          log('yellow', '     → 检查 Chrome 是否有多个实例在运行');
          log('yellow', '     → 尝试关闭所有 Chrome 后重新运行 cdp-tunnel start');
        }
      }
    }

    console.log('');
    if (running && httpOk && extStatus.connected) {
      log('green', '✅ 一切正常! 连接 ws://localhost:' + port + '/devtools/browser/...');
      log('cyan', '   Playwright: chromium.connectOverCDP("http://localhost:' + port + '")');
    } else {
      log('yellow', '⚠️ 有问题需要修复，请根据上面的提示操作');
    }
    console.log('');

    process.exit(0);
  });

function migrateFromLegacy() {
  if (!fs.existsSync(PID_FILE) && !fs.existsSync(EXTENSION_STATE_FILE)) return;

  const oldConfig = getConfig();
  const port = oldConfig.port || 9221;

  if (fs.existsSync(getInstanceDir(port))) return;

  ensureInstanceDir(port);

  try {
    if (fs.existsSync(PID_FILE)) {
      fs.copyFileSync(PID_FILE, getInstanceFilePath(port, 'server.pid'));
      fs.unlinkSync(PID_FILE);
    }
    if (fs.existsSync(EXTENSION_STATE_FILE)) {
      fs.copyFileSync(EXTENSION_STATE_FILE, getInstanceFilePath(port, 'extension-state.json'));
      fs.unlinkSync(EXTENSION_STATE_FILE);
    }
    saveConfig(oldConfig, port);

    log('gray', `  已迁移旧配置到实例目录 (端口: ${port})`);
  } catch {}
}

program.addHelpText('after', `

常用命令:
  $ cdp-tunnel start              启动服务（自动启动 Chrome）
  $ cdp-tunnel start --auto-restart   Chrome 断连时自动重启
  $ cdp-tunnel start --watchdog       服务崩溃时自动重启
  $ cdp-tunnel status             查看状态
  $ cdp-tunnel update             检查并更新
  $ cdp-tunnel diagnose          诊断连接问题
  $ cdp-tunnel extension          安装 Chrome 扩展

快速开始:
  $ npm install -g cdp-tunnel
  $ cdp-tunnel start              # 一行命令搞定！
`);

ensureConfigDir();
migrateFromLegacy();

program.parse();
