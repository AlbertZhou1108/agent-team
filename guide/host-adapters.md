# 宿主配置与适配

[返回产品介绍](../README.md) · [架构](architecture.md) · [限制](limitations.md)

## 内置接入

框架接入 Codex CLI/app-server、Claude Code CLI、DSH CLI。宿主负责账号、认证、模型服务配置与额度；框架提供团队通信工具、回合上下文和请求策略，不代配宿主。

通过 `--hosts /路径/hosts.json` 指定框架配置，例如：

```json
{
  "hosts": {
    "codex": { "adapter": "codex" },
    "writer": { "adapter": "claude" },
    "dsh": { "adapter": "dsh" }
  }
}
```

别名是团队成员选择的宿主名称。`command` 可指定 CLI 绝对路径；Codex、Claude 可设置框架调用所用的 `model` 与 `reasoningEffort`。这些调用参数不是修改宿主账号配置。模型选择必须来自可用目录；不静默切换模型。没有覆盖思考强度时保留宿主行为。

## 安装检查与通信检测

| 接口 | 回答的问题 |
| --- | --- |
| `checkStatus()` | 是否发现已安装、可启动的命令；安装流程仍使用这一语义 |
| `probeConnection()` | 能否通过适配器协议与宿主通信；页面据此显示可用、不可用或未安装 |
| `connectionStatus()` | 最近一次通信检测结果或检测中状态 |
| `cancelProbe()` | 取消并收尾适配器拥有的检测进程 |
| `listModels({ signal })` | 返回规范化模型目录，支持按宿主获取与缓存 |

检测不发送模型消息。Codex 使用 app-server 初始化及目录；Claude 使用控制初始化协议；DSH 使用临时 overlay，并显式禁用任务执行器后读取目录。进程超时、取消、输出上限与清理集中在 [probe.mjs](../src/hosts/probe.mjs)。

协议与宿主版本相关。检测成功不证明账号额度、线上推理或下一回合一定成功；实际宿主错误仍会反馈给用户，不自动登录、修改配置或重放业务消息。

## 新适配器

配置 `{ "module": "/绝对路径/adapter.mjs" }`，模块导出 `createHost(options)`，返回实现 `run(context)` 的对象。完整上下文与事件处理应参照内置实现，而不是只把最终字符串拼成群消息。

适配器需要处理：

- 会话创建/恢复，以及输入接受与最终完成的区别。
- 流式文本、工具调用、错误、取消、进程树收尾与不确定运行。
- 请求策略的支持判断与实际宿主配置记录，不支持时明确拒绝。
- 可选的模型目录、能力与遥测上报，以及独立通信检测。
- 可选的 `executionCapabilities`：声明指定群策略和 shell 配置下真实可用的文件读取、工作区写入、shell 与路径边界能力。未声明路径边界时不能把成员标成可写。
- 可选的主动唤醒 driver：提供环境指纹与对现有会话的真实注入能力。未注册 driver 的宿主保持显式 pull-only。

主要入口：[codex.mjs](../src/hosts/codex.mjs)、[codex-wake.mjs](../src/hosts/codex-wake.mjs)、[wake-drivers.mjs](../src/hosts/wake-drivers.mjs)、[cli-hosts.mjs](../src/hosts/cli-hosts.mjs)、[subprocess.mjs](../src/hosts/subprocess.mjs)、[catalog.mjs](../src/hosts/catalog.mjs)、[policies.mjs](../src/hosts/policies.mjs)。

模型目录可由 CLI 查询；页面设置中的全局模型策略用于新建角色的默认模型说明，不会追溯改写所有已有角色。事件视图只呈现适配器实际观察到的内容，不等同于宿主原生完整历史。
