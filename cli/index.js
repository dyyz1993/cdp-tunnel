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

const program = new Command();

program
  .name('cdp-tunnel')
  .description('Chrome DevTools Protocol Tunnel')
  .version('1.0.0');

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

function getConfig() {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return { port: 9221 };
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function isServerRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

function getServerPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  return parseInt(fs.readFileSync(PID_FILE, 'utf8'));
}

function checkChromeExtension() {
  if (!fs.existsSync(EXTENSION_STATE_FILE)) {
    return { installed: false };
  }
  
  try {
    const state = JSON.parse(fs.readFileSync(EXTENSION_STATE_FILE, 'utf8'));
    if (state.connected && Date.now() - state.lastSeen < 30000) {
      return { installed: true, connected: true };
    }
    return { installed: true, connected: false };
  } catch (e) {
    return { installed: false };
  }
}

function getExtensionPath() {
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

program
  .command('start')
  .description('启动 CDP Tunnel 服务器')
  .option('-p, --port <port>', '指定端口', parseInt)
  .action((options) => {
    const config = getConfig();
    const port = options.port || config.port;
    
    if (isServerRunning()) {
      console.log('');
      log('yellow', '⚠️  服务器已在运行');
      log('cyan', '   端口: ') + console.log(port);
      log('cyan', '   PID:  ') + console.log(getServerPid());
      return;
    }
    
    const extStatus = checkChromeExtension();
    if (!extStatus.installed) {
      printExtensionGuide();
      openChromeExtensions();
    }
    
    ensureConfigDir();
    
    const serverPath = path.join(__dirname, '..', 'server', 'proxy-server.js');
    
    const child = spawn('node', [serverPath], {
      detached: true,
      stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')],
      env: { ...process.env, PORT: port.toString() }
    });
    
    child.unref();
    
    fs.writeFileSync(PID_FILE, child.pid.toString());
    
    if (port !== config.port) {
      config.port = port;
      saveConfig(config);
    }
    
    console.log('');
    log('green', '✓ CDP Tunnel 服务器已启动');
    console.log('');
    console.log('  端口: ' + port);
    console.log('  插件: ws://localhost:' + port + '/plugin');
    console.log('  CDP:  http://localhost:' + port);
    console.log('');
    log('gray', '  日志: ' + LOG_FILE);
    console.log('');
    
    if (!extStatus.installed) {
      console.log('请先安装扩展，然后点击扩展图标连接服务器');
      console.log('');
    }
  });

program
  .command('stop')
  .description('停止 CDP Tunnel 服务器')
  .action(() => {
    if (!isServerRunning()) {
      log('yellow', '⚠️  服务器未运行');
      return;
    }
    
    const pid = getServerPid();
    try {
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(PID_FILE);
      log('green', '✓ 服务器已停止');
    } catch (e) {
      log('red', '✗ 停止服务器失败: ' + e.message);
    }
  });

program
  .command('status')
  .description('查看服务器状态')
  .action(() => {
    const config = getConfig();
    const running = isServerRunning();
    const extStatus = checkChromeExtension();
    
    console.log('');
    console.log('CDP Tunnel 状态');
    console.log('─'.repeat(30));
    console.log('');
    console.log('  服务器: ' + (running ? '\x1b[32m运行中\x1b[0m' : '\x1b[31m已停止\x1b[0m'));
    console.log('  端口:   ' + config.port);
    
    if (running) {
      console.log('  PID:    ' + getServerPid());
      console.log('  CDP:    http://localhost:' + config.port);
    }
    
    console.log('');
    if (extStatus.installed && extStatus.connected) {
      console.log('  扩展:   \x1b[32m已连接\x1b[0m');
    } else if (extStatus.installed) {
      console.log('  扩展:   \x1b[33m已安装但未连接\x1b[0m');
      console.log('  提示:   请点击扩展图标连接服务器');
    } else {
      console.log('  扩展:   \x1b[31m未安装\x1b[0m');
      console.log('  提示:   运行 cdp-tunnel extension 安装扩展');
    }
    console.log('');
  });

function generateGuideHtml() {
  const extensionPath = path.join(__dirname, '..', 'extension-new');
  const realPath = fs.realpathSync(extensionPath);
  
  const templatePath = path.join(__dirname, 'guide.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  
  // 替换路径
  html = html.replace(
    '/Users/xuyingzhou/Project/study-web/cdp-tunnel2/extension-new',
    realPath
  );
  
  // 生成临时 HTML 文件
  const tempHtmlPath = path.join(CONFIG_DIR, 'guide.html');
  ensureConfigDir();
  fs.writeFileSync(tempHtmlPath, html);
  
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

program.parse();
