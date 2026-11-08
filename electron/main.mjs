import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } from 'electron';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureService, serviceAlive, serviceDirectory, stop, badgeCount } from './service.mjs';
import { pickDirectory } from './dialogs.mjs';
import { applicationMenuTemplate } from './menus.mjs';

// 主进程自己不需要这个标记；清掉它，避免后续 spawn 把宿主拉成 GUI 实例。
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const DEV = process.argv.includes('--dev');
// 冒烟模式:由 scripts/electron-smoke.mjs 拉起,面板加载成功即退出,失败返回非零。
const SMOKE = process.env.AGENT_TEAM_SMOKE === '1';
// 受限容器 / 沙箱里 Chromium 无法初始化沙箱与 GPU，开发态可显式放宽。
if (process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
}
const DEV_URL = 'http://127.0.0.1:5173/';
const TRAY_ICON = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVR4Ae3BsQ2AMBAEMP/vv/NBB0GkChIU2F5X5mJUbrRFbVH7XQUxF8RJOcSojGJUdm1Re1gQc0F8ygZ1lwsFwv+XpAAAAABJRU5ErkJggg==';
const directory = serviceDirectory();

const state = { panelUrl: DEV ? DEV_URL : null, showingError: false, quitting: false };
let win;
let tray;
let healthTimer;
let badgeTimer;
// 目录选择器的单飞锁：用方法读写，避免 await 之后再给共享状态赋值。
const pickerLock = {
  busy: false,
  acquire() { if (this.busy) return false; this.busy = true; return true; },
  release() { this.busy = false; },
};
// 待办徽标：待答复的卡片 + 未读消息。「等待回复」不计入，它是待办审计而不是通知。
// 超过两位数时角标会挤，macOS 改用 dock 的字符串角标显示 99+。
const BADGE_CAP = 99;
const badge = {
  count: -1,
  update(count) {
    if (count === this.count) return;
    this.count = count;
    if (count > BADGE_CAP && process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(`${BADGE_CAP}+`);
    } else {
      app.setBadgeCount(Math.min(count, BADGE_CAP));
    }
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(count ? `Agent Team · ${count} 项待处理` : 'Agent Team');
      if (process.platform === 'darwin') tray.setTitle(count ? ` ${count > BADGE_CAP ? `${BADGE_CAP}+` : count}` : '');
    }
  },
};

function allowed(raw) {
  try {
    const candidate = new URL(raw);
    if (candidate.protocol !== 'http:' || candidate.hostname !== '127.0.0.1') return false;
    if (DEV) return true;
    return Boolean(state.panelUrl) && new URL(state.panelUrl).origin === candidate.origin;
  } catch {
    return false;
  }
}

function errorPage(message) {
  const text = String(message).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Agent Team</title>` +
    `<style>body{background:Canvas;color:CanvasText;font:14px/1.7 system-ui;padding:48px;max-width:640px}h1{font-size:18px;font-weight:500}` +
    `button{font:inherit;padding:8px 18px;cursor:pointer;margin-top:16px}</style>` +
    `<h1>本地服务未就绪</h1><p>${text}</p>` +
    `<p>面板仍由本机服务提供。服务恢复后重试即可，聊天记录不会丢失。</p>` +
    `<button id="agent-team-retry">重试</button></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 960, minHeight: 640,
    title: 'Agent Team', show: false,
    // Electron 44+ 内置窗口状态持久化：位置、尺寸、显示模式按 name 保存。
    name: 'agent-team-main', windowStatePersistence: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (state.quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (allowed(url)) return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function showWindow() {
  const window = ensureWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function refreshBadge() {
  if (!state.panelUrl) return;
  try {
    const response = await fetch(new URL('api/workbench', state.panelUrl));
    if (!response.ok) return;
    const workbench = await response.json();
    badge.update(badgeCount(workbench));
  } catch { /* 服务重启期间静默跳过，下一轮再刷新 */ }
}

function openInBrowser() {
  if (state.panelUrl) shell.openExternal(state.panelUrl);
}

async function stopServiceFromMenu() {
  try { await stop(directory); } catch { /* 未运行时 stopService 返回 false */ }
  state.panelUrl = null;
  showError('本地服务已停止。点击重试可重新启动。');
}

function createApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
    platform: process.platform,
    panelUrl: state.panelUrl,
    dev: DEV,
    actions: {
      showWindow,
      openInBrowser,
      reconnect: () => { void openPanel(); },
      stopService: stopServiceFromMenu,
      openGuide: () => shell.openExternal('https://github.com/AlbertZhou1108/agent-team/blob/main/guide/user-guide.md'),
    },
  })));
}

function showError(message) {
  state.showingError = true;
  badge.update(0);
  if (win && !win.isDestroyed()) win.loadURL(errorPage(message));
  refreshMenu();
}

async function openPanel() {
  const window = ensureWindow();
  try {
    let url = DEV_URL;
    if (!DEV) {
      const instance = await ensureService(directory);
      url = instance.url;
      state.panelUrl = url;
    }
    await window.loadURL(url);
    state.showingError = false;
    refreshMenu();
    if (SMOKE) {
      console.log(`AGENT_TEAM_SMOKE_READY ${url}`);
      setTimeout(() => quit(), 150);
    }
  } catch (error) {
    if (SMOKE) {
      console.error(`AGENT_TEAM_SMOKE_FAILED ${error.message}`);
      app.exit(1);
      return;
    }
    showError(error.message);
  }
}

function refreshMenu() {
  // 服务地址变化（启动成功 / 停服 / 错误页）时，应用菜单的启用状态一起刷新。
  createApplicationMenu();
  if (!tray) return;
  const status = DEV ? '开发模式（服务由 npm run dev 管理）'
    : state.panelUrl ? `本地服务 ${state.panelUrl}` : '本地服务未就绪';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Agent Team', click: showWindow },
    {
      label: '在浏览器中打开',
      enabled: Boolean(state.panelUrl),
      click: openInBrowser,
    },
    { type: 'separator' },
    { label: status, enabled: false },
    {
      label: '停止本地服务',
      enabled: !DEV && Boolean(state.panelUrl),
      click: stopServiceFromMenu,
    },
    { type: 'separator' },
    { label: '退出桌面窗口（服务继续运行）', click: () => quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON, 'base64'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Agent Team');
  refreshMenu();
}

// 徽标比服务存活检查更敏感：窗口缩到托盘时它是唯一能看见的信号，
// 延迟 15 秒会像卡住，所以单独一条 5 秒的轮询。
function startBadgePoll() {
  if (badgeTimer) return;
  badgeTimer = setInterval(() => {
    if (state.quitting || state.showingError || !win || win.isDestroyed()) return;
    void refreshBadge();
  }, 5000);
  badgeTimer.unref?.();
}

function startHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    if (state.quitting || state.showingError || !win || win.isDestroyed()) return;
    // dev 模式的服务由 npm run dev 托管，不能按 applicationData() 判活。
    if (DEV) return;
    if (!await serviceAlive(directory)) {
      showError('本地服务已停止，可以重试重新连接。');
    }
  }, 15000);
  healthTimer.unref?.();
}

function quit() {
  state.quitting = true;
  if (healthTimer) clearInterval(healthTimer);
  if (badgeTimer) clearInterval(badgeTimer);
  if (tray && !tray.isDestroyed()) tray.destroy();
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => { state.quitting = true; });
  // 注册监听器即阻止「最后一个窗口关闭时自动退出」；关窗只是隐藏到托盘。
  app.on('window-all-closed', () => {});
  ipcMain.handle('service:retry', async () => {
    await openPanel();
    return true;
  });
  // 原生目录选择器：只在桌面壳里存在，浏览器版仍走 /api/local/directory-picker。
  ipcMain.handle('directory:choose', async () => {
    if (!pickerLock.acquire()) return { path: null };
    try {
      const parent = win && !win.isDestroyed() ? win : undefined;
      return pickDirectory(options => dialog.showOpenDialog(parent, options), {
        title: '选择 Panel Agent 私人工作区',
        buttonLabel: '选择',
        properties: ['openDirectory'],
      });
    } finally {
      pickerLock.release();
    }
  });
  app.whenReady().then(async () => {
    createTray();
    await openPanel();
    await refreshBadge();
    startBadgePoll();
    startHealthCheck();
  });
}
