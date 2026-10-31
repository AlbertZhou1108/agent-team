# Claude 附件最小真实纵向验证

日期：2026-10-31。测试脚本：[attachment-claude-vertical.mjs](../scripts/probes/attachment-claude-vertical.mjs)。这是一条**实验上传包装 → 正式消息 API → 真实 Bus → 未修改的 Claude 适配器 → 真实 CLI/模型**的验证链，**不是正式附件功能已实现**。

## 结果

6 个真实模型调用用例完成，8 项核验全部通过。最终证据目录：`/tmp/at-claude-vertical-kvxfiJ/`。关键文件：`evidence.json`（调用、策略、原生事件及回答）、`expected.json`（独立随机答案）、`checks.json`（核验）、`catalog.json`（真实模型目录）、`workspace/uploads/`（持久化上传文件）、`data/`（实验服务状态）。

本机 CLI 版本 `2.1.215`。本次初始化模型标识为 `deepseek-v4-flash[1m]`，assistant.model 为 `deepseek-v4-flash`。结论属于**当前 Claude Code 宿主及当前模型路由**，不外推全部 Claude/Anthropic 模型。

| 用例 | 完整路径与证据 | 结果 |
| --- | --- | --- |
| `01-uploaded-text` | HTTP 上传随机 TXT 字节到实验网关；网关返回生成 ID、绝对路径、SHA-256；通过正式 `POST /api/panel-agent/messages` 发送路径；真实 Claude `Read` 返回内容 | 随机口令准确，Read 工具事件可见 |
| `02-uploaded-image` | 同网关上传自制 3×4 随机色块 PNG，正式 panel 消息仅含路径和问题；真实 Read 图片 | 12 格颜色顺序全部准确；答案未进入 prompt/文件名 |
| `03-restart-reread-text` | 完整关闭 `startServer`，重新构造 `createClaudeHost`、Bus 和服务，使用同数据目录与同上传路径；明确要求重新 Read | 有新的 Read 调用，口令准确；同 Claude 会话恢复 |
| `04-restart-reread-image` | 同样重建后重新 Read 原图片路径 | 有新的 Read 调用，12 格颜色顺序准确；不是只重复历史回答 |
| `05-corrupt-image` | 网关持久化声明为 image/png、内容实为 `THIS_IS_NOT_A_PNG` 的字节；走正式 panel 消息与 Read | Read 返回 `is_error` 及 invalid PNG/JPEG/GIF/WebP；模型如实报告不能读取，不编造图像内容 |
| `06-communication-policy-no-read` | 新建真实 Panel-led 团队，使用真实 coordination session，经 `Bus.runPanelTurn` 调用；现有框架自动应用 communication 策略；提供此前未给过的新随机文件路径 | 无 Read/Bash 工具，返回 UNAVAILABLE，未取得随机口令；没有改宿主策略或适配器 |

自动核验：`textCorrect`、`textRereadCorrect`、`imageCorrect`、`imageRereadCorrect`、`rereadToolsObserved`、`communicationDenied`、`corruptToolError`、`sameSessionAfterRestart` 均为 true。

私人会话 ID：`ac70050a-de9f-4945-a1a8-e4593deed6d2`。重建前后 ID 一致。TXT 随机口令：`32efaf74ede01ce10f78ef023c0a2cc3`。PNG 期望与实际均为：`[orange,green,green,orange,orange,red,green,blue,red,orange,green,orange]`。

## 真实链路与实验边界

1. 上传层是本探针创建的独立 localhost HTTP 服务 `POST /probe-upload`，接收原始字节、限制 1 MiB，使用生成 UUID 路径和 0600 权限保存，记录 SHA-256。它**不是生产路由**，没有生产附件表、生命周期或鉴权契约。为测试错误传播，它不校验 PNG 内容。
2. Agent 创建经过正式 `POST /api/panel-agent`，模型选择经过真实 `Bus.modelCatalog` 及 `createClaudeHost.listModels`；没有伪造模型目录或 fake host。
3. 正例和坏图走正式 `POST /api/panel-agent/messages`，请求仍是**现有文本消息中的本地附件路径**。现有框架没有接收附件 ID；实验网关返回的元数据也未进入正式消息结构。
4. 宿主对象只包装 `run` 来旁路记录事件，再完整委托真实 `run`；未替换工具结果、答案、模型、权限或 stdin。核心业务文件未修改。
5. 私人会话使用正式 read-only 配置；现有框架仍设置 `allowShell=true`，真实宿主工具列表包含 Bash。测试问题明确只用 Read，日志确认正例没有 Bash 调用。因此本次证明“确实通过 Read”，**不是操作系统级禁止一切 shell 的证明**。
6. 权限负例走真实团队 coordination，不是私人 read-only。现有框架 communication 策略 `allowShell=false`，Claude 内置文件工具为空。该负例没有检查所有可能的 MCP 间接越权方式，不能称为全面安全审计。
7. 上传目录在私人 workspace 内，文件持久化与服务数据均独立于生产 `work/dev`；重建保留这些文件，确认本地路径可复用。
8. 服务重建发生在同一个 Node 探针进程里，但旧服务、Bus 和适配器对象已关闭丢弃，随后重新构造；每轮 Claude CLI 本来就是独立进程。未测试机器重启、宿主升级或跨机器路径。

## 仍未验证及实现前约束

- 没有前端上传动作、正式附件 API/表、历史下载、消息附件关联、清理、并发、取消、重试和大文件测试；不能标记“前端到框架附件端到端已完成”。
- 这里只验证当前适配器可用的**路径 + Read**路径。原生 image block 的 CLI 验证见 [Claude 宿主附件实际验证](research/host-attachments-claude-verification.md)，现有生产适配器仍不传结构化图片。
- 坏图在工具层失败，但正式 panel 回合会以成功且含失败说明文本完成；正式附件状态需要独立识别，不能只依赖 HTTP 200 或回合 completed。
- 同路由 PDF Read 页码图像回退、原生 PDF 失败等宿主单独结果见上述报告；本纵向探针未再次发送 PDF。
- 普通团队 communication 模式无法仅凭路径读取上传文件；后续必须明确附件读取权限和输入契约，不能默认因为私人会话成功所有团队都可用。

## 复跑

`node --disable-warning=ExperimentalWarning scripts/probes/attachment-claude-vertical.mjs`

会创建新的 `/tmp/at-claude-vertical-*` 目录、临时端口与独立测试会话，使用已有登录和当前默认模型路由；每次模型调用 90 秒后请求停止。脚本不写用户配置、不读凭证内容，不修改生产适配器。输出只含随机测试数据和路径。
