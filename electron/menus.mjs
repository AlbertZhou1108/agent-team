/**
 * 应用菜单模板。纯函数：enabled 只由服务地址与运行模式决定，
 * 便于在不启动 Electron 的情况下验证「菜单项随服务状态动态启用」。
 * actions 里的回调由主进程注入。
 */
/**
 * 窗口原生壳选项（纯函数，便于单测各平台配置）：
 * macOS 保留系统红黄绿控制点与顶部菜单栏；Windows / Linux 采用无边框窗体由前端绘制统一 38px 顶栏。
 */
export function windowChromeOptions(platform = 'darwin') {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
    };
  }
  return { frame: false };
}

export function desktopMenuState({ panelUrl = null, dev = false, showingError = false, version = '' } = {}) {
  return {
    hasService: Boolean(panelUrl) && !showingError,
    dev: Boolean(dev),
    showingError: Boolean(showingError),
    version: String(version || ''),
  };
}

export function applicationMenuTemplate({ platform = 'darwin', panelUrl = null, dev = false, actions = {} } = {}) {
  const hasService = Boolean(panelUrl);
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '显示 Agent Team', accelerator: 'CmdOrCtrl+Shift+A', click: actions.showWindow },
        { label: '在浏览器中打开', enabled: hasService, click: actions.openInBrowser },
        { label: '重新连接服务', click: actions.reconnect },
        { type: 'separator' },
        { label: '关闭窗口', role: 'close' },
        ...(platform === 'darwin' ? [] : [{ label: '退出 Agent Team', role: 'quit' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        { type: 'separator' },
        { label: '前置全部窗口', role: 'front' },
      ],
    },
    {
      label: '服务',
      submenu: [
        { label: '停止本地服务', enabled: !dev && hasService, click: actions.stopService },
        { label: '重新连接', click: actions.reconnect },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '使用指南', click: actions.openGuide }],
    },
  ];
}
