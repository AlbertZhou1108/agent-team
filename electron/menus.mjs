/**
 * 应用菜单模板。纯函数：enabled 只由服务地址与运行模式决定，
 * 便于在不启动 Electron 的情况下验证「菜单项随服务状态动态启用」。
 * actions 里的回调由主进程注入。
 */
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
        { role: 'close' },
        ...(platform === 'darwin' ? [] : [{ role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    {
      label: '服务',
      submenu: [
        { label: '停止本地服务', enabled: !dev && hasService, click: actions.stopService },
        { label: '重新连接', click: actions.reconnect },
      ],
    },
    {
      role: 'help',
      submenu: [{ label: '使用指南', click: actions.openGuide }],
    },
  ];
}
