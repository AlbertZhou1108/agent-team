const { contextBridge, ipcRenderer } = require('electron');

// 渲染进程只拿到桌面壳提供的能力：知道自己在桌面里、服务断开时重连、
// 以及用原生对话框选目录。每一项都必须可选注入，浏览器入口没有这些能力。
contextBridge.exposeInMainWorld('agentTeam', {
  isDesktop: true,
  platform: process.platform,
  retryService: () => ipcRenderer.invoke('service:retry'),
  chooseDirectory: () => ipcRenderer.invoke('directory:choose'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (listener) => {
    const handler = (_event, value) => listener(Boolean(value));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  getMenuState: () => ipcRenderer.invoke('desktop:menu-state'),
  onMenuStateChange: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop:menu-state-changed', handler);
    return () => ipcRenderer.removeListener('desktop:menu-state-changed', handler);
  },
  runMenuAction: (action) => ipcRenderer.invoke('desktop:action', action),
});

// 错误页是主进程内联的 data URL，不含脚本；重试按钮由 preload 绑定。
window.addEventListener('DOMContentLoaded', () => {
  const retry = document.getElementById('agent-team-retry');
  if (retry) retry.addEventListener('click', () => ipcRenderer.invoke('service:retry'));
});
