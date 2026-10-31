# 宿主附件能力核查

> 本文是实测前的接口核查快照。实际验证已完成，以[2026-10-31 实测总报告](host-attachment-verification-20261031.md)及分项报告为准。

核查日期：2026-10-31。范围：只读帮助、协议、已安装源码和官方资料；**没有运行真实模型调用，因此没有任何一项可标为端到端通过**。未修改适配器、框架或前端。

## 结论

“宿主有附件子系统”“当前非交互入口接受附件”“所选模型能处理附件”“当前权限允许读取”是四个不同条件。普通文件路径不是原生文件字节输入，图片可入协议也不等于当前模型视觉可用。

| 宿主/本机版本 | 接口层证据 | 项目当前入口 | 当前判断 |
| --- | --- | --- | --- |
| Codex CLI 0.158.0 | 官方 app-server `turn/start.input` 接受 `text`、`image` URL、`localImage` 路径；本机生成 `v2/UserInput.ts` 也有 image（url/fileId）、localImage，无通用 file variant | `src/hosts/codex.mjs` 目前只发送 text | 原生图片有明确协议支持；通用文件应另验证工具读取，不能视为原生 file 输入；实际模型调用未测 |
| Claude Code 2.1.215 | 官方 Agent SDK streaming input 展示 base64 image block；CLI 提供 `--input-format stream-json` | `src/hosts/cli-hosts.mjs` 当前用 `-p` argv 文本，无结构化 stdin | 有结构化图片输入路径；当前文本入口未接；CLI wire、具体模型和恢复会话需实际验证 |
| DSH 0.2.0-rc.2 | 本机 attachment 包支持 image/file refs；通用文件投影为只读路径提示，图片由 provider adapter 构造请求；但 headless 帮助及源码只有 task 字符串 | `dsh headless ...task` | 底层能力不等于 headless 可接入；当前 headless 没有发现附件参数或结构化附件输入，需另选协议/插件入口后再验证 |

Codex 的本机协议检查结果由主代理提供：`codex app-server generate-ts --out /tmp/agent-team-attachment-protocol`。版本检查没有调用推理。

## 一手来源

- [OpenAI app-server 文档](https://learn.chatgpt.com/docs/app-server)：Turns 列出 image URL、localImage path 输入。此事实仅证明协议可表达图片。
- [OpenAI CLI 参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)：`--image/-i` 支持初始图片与 exec resume 后续图片；不要将其他命令的能力移植到 queue 等入口。
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)：示例用用户消息 content 数组含 base64 image；single-message string 模式明确不支持直接图片附件。错误 source 可能被替换为文本提示，因此“进程成功退出”不是图片被理解的证据。
- [Claude CLI 参考](https://code.claude.com/docs/en/cli-reference)：`--input-format` 支持 text/stream-json；`--file` 是 file_id:relative_path 的启动下载资源，不能解释为本地文件上传参数。
- [DSH 官方 attachment README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment/README.md)：图像持久化后投影请求；通用文件原始字节不直接传给 provider，而是提供持久路径供文件工具读取。远端 master 可能与本机版本不同，结论优先看本机源码。
- 本机 DSH：`/Users/zhoujunxiang/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment/README.md`，描述 FileBlock、saveFile、fileHostPath 和图像请求投影。
- 本机 DSH headless：同安装目录 `@deepseek-ai/dsh-headless/lib/startup.js`、`lib/index.js`：命令参数 task 字符串；提交内容为 text task。`dsh headless --help` 只列 task、json、session-id，无 attachment 参数。

## 权限边界

主代理检查到：`src/hosts/policies.mjs` 的 Codex 策略禁用 view_image，shell 取决于 allowShell；Claude communication 模式无内置工具，其他模式才有 Read。因而“给路径让工具读”必须针对实际模式测试。原生图片输入也不能依赖 view_image 的工具读取结论。

## 后续验证矩阵

所有以下实测均为 **待执行**，不能用文档支持替代结果。

| 阶段 | 用例 | 成功证据 |
| --- | --- | --- |
| 宿主原生能力 | 新建隔离会话，传入自制图片，提示不含图中答案 | 正确描述随机图形/颜色/文字；确认请求/历史确实包含 image，不靠文件名猜测 |
| 普通文件 | 临时文本文件内写独立随机口令，提示仅给路径 | 可观察到读取工具调用并返回准确口令；分别测读取允许/禁止 |
| 入口对照 | 同一素材分别走原生结构化输入与当前文本入口 | 独立记录接口接受、provider 接受、模型回答与工具事件 |
| 会话持续性 | 首轮附件，后续不再附加；重启后恢复 | 记录仍可回答与附件是否保留，避免把文本摘要记忆当附件持久化 |
| 模型/提供方 | 每个项目实际模型路由单独测 | 不从宿主支持推断模型视觉支持；失败保留模型/提供方错误 |
| 边界 | 缺失文件、坏图、不可读路径、不支持模型 | 明确失败且不误报成功；无越权读取 |

执行顺序：先完成宿主隔离实测，再决定适配器能力契约；随后才讨论框架附件持久化与前端上传。DSH 先确定 headless 之外的可用入口，不先假设现有 task 参数能携带图片。
