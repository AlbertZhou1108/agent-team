# 跨平台兼容性

项目面向 Windows 原生、macOS 和 Linux；WSL 作为 Linux 环境运行，数据目录、宿主和命令均以服务所在环境为准。

## 公共边界

- IPC：`socketFor()` 为 Windows 生成命名管道，为 macOS/Linux 生成 Unix socket。命名管道不执行文件 chmod/unlink。
- 宿主进程：所有适配器通过 `hosts/subprocess.mjs` 启动。Windows 标准 npm `.cmd` 启动器解析为真实 JS/EXE 入口，以保留 JSON、引号、Unicode 和特殊字符；其他命令由 cross-spawn 处理。配置里的 command 是程序路径，参数单独传递。
- 停止：Windows 使用 `taskkill /T /F` 回收进程树；Unix 使用独立进程组，先 SIGTERM，再 SIGKILL。不确定的停止结果返回 runtimeUnknown，不伪造成功。
- 文件夹选择：macOS 使用系统对话框；Windows 使用 STA PowerShell 的 FolderBrowserDialog；Linux 使用 zenity，缺失时回退 kdialog。无图形会话或依赖时可以手动输入路径。
- 测试清理：先关闭服务和数据库，再删除目录。不能依赖 Unix 允许删除已打开文件的行为。

## 验证

本地依次运行 `npm ci`、`npm run check`、`npm run build`、`npm test`、`npm run dev`。

`.github/workflows/compatibility.yml` 在 Windows/macOS/Linux 使用 Node 24 执行检查、构建和完整测试。新增系统相关逻辑应进入对应边界，并补充行为测试。

当前 Windows 本机已验证开发服务、IPC 重启、npm 启动器参数保真、进程树停止，以及 Codex/Claude Code 的真实版本命令。DSH 本机未安装；模拟适配器测试不代表真实宿主的认证、权限和业务回合已验证。macOS/Linux 需由对应环境的 CI 和真实宿主验证后确认。

本轮仅处理兼容性，尚未加入宿主状态展示或安装业务。
