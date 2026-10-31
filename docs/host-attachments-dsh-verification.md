# DSH 附件能力实测

日期：2026-10-31；本机 DSH 0.2.0-rc.2。以下是真实推理测试，不是根据文档推断。

## 环境与隔离

工作目录、测试文件、session/storage、命令 patch 和日志位于 `/tmp/agent-team-attachment-verification/dsh/`。使用现有登录和模型配置，没有读取凭证内容，没有更改用户配置和业务代码。每次调用通过临时 `--patch` 指定 read-only sandbox、approval never、独立 session/storage。工具禁止对照使用 invocation-only 插件 restrict allow=[]。原生 ACP 最终验证另将 attachment-local.dshHome 指到该目录下 attachment-home。

初始 headless read_image 及第一次 ACP 图片测试使用宿主默认附件存储（会写入此次自制图片的持久副本）；后续原生 ACP 复验改为隔离附件存储。没有清理用户存储中的对象，避免影响共享引用。测试文件无敏感信息。

请求观察插件只记录 agent/request 的 provider/model，不读取 auth/header。观察到的路由是 **deepseek-official / deepseek-flash**。这证明请求路由，不能独立证明远端实际执行模型。

## 结果

| 用例 | 结果 | 证据与范围 |
| --- | --- | --- |
| headless 文本路径 | 通过 | 调用 read 精确读取 probe.txt，返回独立随机口令；prompt 未包含口令。text.stdout.jsonl；exit 0，约 3.1 秒 |
| 文本会话进程重启续接 | 通过 | `--session-id` 同一 session 的 turn 2 无工具调用准确复述口令。resume.stdout.jsonl |
| headless 图片路径 | 通过 | 调用 read_image，返回 image/png 600×300 信息，后续准确报告 4 个绿色方块。prompt 无颜色与数量。image.stdout.jsonl |
| headless 无文件工具对照 | 实际读取被阻止，回答质量失败 | 没有 tool_call/tool_result，未泄露口令，但模型把 DSML bash 调用语法当普通文本输出，exit 0。no-tools.stdout.jsonl。不能把完成/退出码解释为已读取 |
| 缺失文件 | 明确失败 | read 返回 status:error、not found，最终回复错误；没有猜测。missing.stdout.jsonl |
| 坏 PNG | 明确失败 | read_image 返回 status:error、Unsupported or malformed image data，最终说明错误。corrupt.stdout.jsonl |
| 最简 PDF 路径 | 仅原始文本可读通过 | read 将未压缩 PDF 的 ASCII 源码作为文本返回，模型从 `(DSH-PDF-...) Tj` 提取随机口令。不是 PDF 渲染、页面理解或压缩/扫描 PDF 支持。pdf.stdout.jsonl |
| ACP 默认 route 原生 image | 拒绝 | 默认 deepseek-official/deepseek-v4-flash 的 initialize 宣告 image:false；session/prompt image block 返回 -32602 inline image prompts were not advertised by this connection。这是实际协议拒绝，未进入推理 |
| ACP 改为 deepseek-flash 原生 image | 通过 | invocation-only patch 设置 ACP provider/model；initialize image:true；发送 inline base64 PNG 后，无 tool_call，准确报告绿色、方块、4；stopReason:end_turn。最终 acp.stdout.jsonl/acp.results.json 使用隔离附件目录 |
| 图片会话恢复 | 首次失败，一次复验通过 | 原 headless 图片会话在重启后提问，turn_end error.code:TRANSPORT、DeepSeek Messages transport failed，exit 1。image-resume.stdout.jsonl。首次调用同时切换 attachment root，是干扰因素，不能据此归咎持久化；恢复原附件存储后仅重试一次，turn 3 exit 0，1.4 秒，无工具准确回复 Green — 4 squares。仅证明会话答案记忆可用，不能证明图片字节恢复 |

ACP 原生图片的成功与 headless 路径读取是两种入口：前者直接传结构化图片，不需文件工具；后者当前项目只传文字路径，依赖 read_image 工具和读取权限。已安装 headless runner 的 followup 固定构造 text block，没有图片或普通附件 CLI 参数。

## 日志

- `/tmp/agent-team-attachment-verification/dsh/expected.json`：本次随机素材答案（不在提示中）。
- `text.stdout.jsonl`、`resume.stdout.jsonl`、`image.stdout.jsonl`：正向及续接。
- `no-tools.stdout.jsonl`、`missing.stdout.jsonl`、`corrupt.stdout.jsonl`：边界。
- `pdf.stdout.jsonl`：最简 PDF 源码读取。
- `acp.stdout.jsonl`、`acp.results.json`：隔离附件存储的原生图片复验。
- `initial-acp.stdout.jsonl`：此前默认附件存储的同 route 成功结果。
- `request-models.jsonl`：只含 provider/model 的请求观察。
- `image-resume.stdout.jsonl`、`image-resume-retry.stdout.jsonl`：恢复失败/一次复验。
- `acp-probe.py`、`run-probes.py`、`negative-probes.py`：调用脚本；每个真实模型调用设定超时。

默认 deepseek-v4-flash 的 ACP 拒绝再次独立复现，完整结果保留在 unsupported-acp.stdout.jsonl、unsupported-acp.results.json；这次在附件入模之前被拒绝，没有推理调用。

## 尚不能推断

只验证以上两个 DeepSeek 路由，没有验证 deepseek-account、Pro、所有图片格式、尺寸上限或并发。图片恢复首次失败不能直接断言稳定失败；一次重试成功也只能证明文本记忆续接，也不能用模型正确复述旧答案证明恢复了图片字节。没有验证通用原生 file block、DOCX/XLSX、压缩或扫描 PDF、音视频。先完成宿主入口和权限能力结论，之后再设计框架/适配器/前端。

## 强图片恢复对照（补充实测）

**通过。** 使用已验证的 ACP deepseek-official/deepseek-flash、隔离 session/storage/attachment-home，创建新的随机 2×3 多色方块图片。首轮提示只问行列，不描述任何颜色；模型回答 `2 rows, 3 columns`，首轮 reasoning 同样没有颜色信息，无工具调用。结束进程后，新进程通过已安装版本支持的 `session/resume`（而非未实现的 `session/load`）恢复同一 session，第二轮不再发送图片，也不给路径，禁止工具，要求按行依次报告六种颜色。模型准确回复：purple, red, orange / blue, green, yellow，与独立 expected 文件完全一致；没有工具调用，stopReason:end_turn。

这是比复述历史答案更强的证据：第二轮请求的颜色与顺序从未在首轮文本回答或 reasoning 中披露，需保留图像信息才能回答。仍仅代表本次 route、格式及会话恢复用例，不泛化到所有模型。

证据全部在 `/tmp/agent-team-attachment-verification/dsh/`：`recovery-grid.png`、`recovery-expected.json`、`recovery-initial.stdout.jsonl`、`recovery-initial.results.json`、`recovery-resume.stdout.jsonl`、`recovery-resume.results.json`；脚本 `recovery-initial.py`、`recovery-resume.py`。日志没有配置/凭证内容，模型观察只记录 provider/model。
