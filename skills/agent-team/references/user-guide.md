# 启动与用户操作

## 找到实例

确认框架仓库、任务工作目录、数据目录和宿主选择。这几种目录用途不同；优先复用已有实例，端口以本次启动输出为准。

普通用户使用发行包打开浏览器面板，具体步骤见框架仓库的 `guide/quick-start.md`。宿主独立安装、登录并准备额度；框架检测只验证通信，不发送模型消息。

外部 Agent 使用源码 CLI 时，在框架仓库先查看 `node src/cli.mjs --help` 与 `package.json`。`npm start` 会先构建前端。已有服务使用 chat/new 等命令连接；不要对相同数据目录重复启动 serve。

```bash
# 独立服务：启动本身不创建成员
npm start -- serve --data /框架数据绝对路径

# 连接已有服务创建团队；会调用模型生成成员自述
npm start -- new --name 方案讨论 --lead codex --members 策划=claude,审阅=dsh \
  --workspace /任务工作目录 --policy workspace-write --data /框架数据绝对路径

# 查询与连接
npm start -- groups --data /框架数据绝对路径
npm start -- state --group 团队编号 --data /框架数据绝对路径
npm start -- members --group 团队编号 --data /框架数据绝对路径
npm start -- chat --group 团队编号 --data /框架数据绝对路径
```

`start`（不带子命令）启动服务后直接建群并进入聊天，不经过准备审批；`--group` 则连接该服务数据中的已有群。此入口退出会停止自己启动的总线。独立 serve 的生命周期另行管理。

CLI 新建团队默认 workspace-write；页面建群默认只读。依据用户需求显式选择 communication/read-only/workspace-write。可选 `--charter 文件` 是纯文本团队说明，不构成授权门禁。成员创建、聊天、协作与摘要会正常消耗模型额度。

## 共享指令与管理

普通 CLI 输入进入主成员私聊；`/direct 文本` 发送到团队调度并写入群记录。Panel Agent 私人助手是另一个入口，转交方式见[会话说明](conversation-agent.md#从私人咨询转交团队)。

聊天命令以 `/help` 为准，包括查询、共享指令、成员增减、停止、重试、核实运行、归档/恢复与删除。需要非交互调用时，按 CLI `--help` 的子命令和参数执行；没有通用群消息正文读取子命令。

用户启动器使用 `npm run launch -- --data /独立数据目录`；状态和停服分别加 `--status`、`--stop`，不打开网页加 `--no-open`。程序启动器默认系统应用数据目录；开发 CLI 默认 `work/local`。再次启动可复用已运行实例，关闭网页不会停止后台工作。

日常操作见仓库 `guide/user-guide.md`，完整命令见 `guide/cli.md`。独立安装的 Skill 通过已确认的框架仓库定位这些文档，不假定它们位于 Skill 的相对上级目录。
