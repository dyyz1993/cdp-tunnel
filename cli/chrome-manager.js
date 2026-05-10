#!/usr/bin/env node
'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const platform = os.platform();
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    ],
    linux: [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ],
  };

  const paths = candidates[platform] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isChromeRunning() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const result = execSync('pgrep -x "Google Chrome" || pgrep -x "Chromium" || pgrep -x "Google Chrome Helper" || true', { encoding: 'utf8' });
      return result.trim().length > 0;
    }
    if (platform === 'win32') {
      const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
      return result.includes('chrome.exe');
    }
    const result = execSync('pgrep -f "chrome|chromium" || true', { encoding: 'utf8' });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function getExtensionPath() {
  return path.resolve(__dirname, '..', 'extension-new');
}

function launchChromeWithExtension() {
  const chromePath = findChromePath();
  if (!chromePath) {
    console.error('[AUTO-RESTART] Chrome not found. Set CHROME_PATH env var.');
    return false;
  }

  const extensionPath = getExtensionPath();
  if (!fs.existsSync(extensionPath)) {
    console.error('[AUTO-RESTART] Extension directory not found:', extensionPath);
    return false;
  }

  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      const appName = chromePath.replace(/\/Contents\/MacOS\/.*$/, '');
      execSync(`open -a "${appName}" --args --load-extension="${extensionPath}"`, {
        timeout: 10000,
        stdio: 'ignore',
      });
    } else if (platform === 'win32') {
      spawn(chromePath, [`--load-extension=${extensionPath}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      spawn(chromePath, [`--load-extension=${extensionPath}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }

    console.log(`[AUTO-RESTART] Chrome launched with extension: ${chromePath}`);
    return true;
  } catch (err) {
    console.error('[AUTO-RESTART] Failed to launch Chrome:', err.message);
    return false;
  }
}

module.exports = {
  findChromePath,
  isChromeRunning,
  getExtensionPath,
  launchChromeWithExtension,
};
