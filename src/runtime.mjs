/**
 * 决定本机 Node 脚本由哪个可执行文件运行，以及需要附加的环境。
 *
 * Electron 的 process.execPath 指向应用二进制：不加 ELECTRON_RUN_AS_NODE
 * 就会拉起一个 GUI 实例，而不是执行 cli.mjs。MCP 配置由外部宿主读取并
 * spawn，标记必须写进配置本身，不能依赖环境变量继承。
 *
 * electron 参数可注入，便于在不启动 Electron 的前提下验证两种分支。
 */
export function nodeRunner({ execPath = process.execPath, electron = Boolean(process.versions.electron) } = {}) {
  return electron
    ? { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: execPath, env: {} };
}
