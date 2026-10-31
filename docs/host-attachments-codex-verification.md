# Codex 宿主附件实测

日期：2026-10-31（Asia/Shanghai）。本机 codex-cli 0.158.0。通过实际 app-server stdio JSON-RPC 调用推理，非 mock。业务代码未修改。

## 环境和方法

- 使用独立临时工作区 `/tmp/agent-team-attachment-verification/codex`、独立 thread，使用当前登录和模型路由。未读取凭证，未更改用户配置。
- `thread/start` 返回 model=`gpt-6.1-sol`、modelProvider=`custom`。这是宿主返回的路由信息，不能证明代理上游最终物理模型身份。stderr 对此模型提示 fallback model metadata；成功结论仅覆盖此本机路由。
- 复用项目 `codexPolicyConfig` 并禁用配置中的 MCP；只读 sandbox、approval never。图片组关闭 shell、view_image 和其他工具，不允许读取答案文件；文本正例仅开放 shell。没有启用业务动态工具。
- 随机 TXT 内容和图中随机字符串由测试脚本生成，答案存于独立 expected 文件，不在提示词/文件名中。每次只要求读取指定素材。
- 图片 A：`526DD2`、蓝色圆；图片 B：`B34BEE`、红色矩形。图中六格颜色另随机生成。
- 官方协议背景：[app-server](https://learn.chatgpt.com/docs/app-server)。本机生成类型 `/tmp/agent-team-attachment-protocol/v2/UserInput.ts`，另做真实非法 file 请求验证。

## 实测结果

| 用例 | 实际证据 | 结果 |
| --- | --- | --- |
| TXT 路径 + 允许 shell | commandExecution 使用 cat 读取唯一指定 sample.txt，回答准确匹配 16 位随机口令 | 通过；工具读取，不是原生 file 输入 |
| 同一 TXT 路径 + 禁用工具 | 无工具事件，回答 UNAVAILABLE | 对照通过 |
| localImage 新会话 | userMessage.content 明确含 localImage，回答 A 的字符串/形状/颜色全部正确，无工具事件 | 原生图片通过 |
| image data URL | 发送 B 的 PNG base64 data URL，正确回答字符串/形状/颜色，无工具事件 | 原生图片通过 |
| 终止 app-server 后 resume | 新进程 thread/resume，未重新附图，复述 A 正确 | 上下文恢复通过，但此题本身可依靠上轮文字答案 |
| resume 中新增图片 | 同一恢复 thread 附 B，正确回答新字符串和红色矩形 | 续接新图片通过 |
| 恢复后询问未曾回答的视觉细节 | 第一轮六格图只问行列，回答 2×3；关闭进程再恢复，仅问颜色，正确给出 black/blue/purple/red/orange/green 全部顺序，无工具 | 更强的图像上下文保留证据；未测试源文件移除或长期保留 |
| 两张图片同回合 | 无工具，按顺序准确返回 A/B 的两组字符串、形状、颜色 | 通过 |
| 纯文本图片路径、禁用工具 | 无工具，回答 UNAVAILABLE | 对照通过，路径不等于原生图片 |
| localImage 路径不存在 | 回合 completed、无 protocol error，模型答 UNAVAILABLE | 未识别；宿主回合成功不能代表附件成功 |
| localImage 非图片字节 | stderr 明确 failed to prepare message image / unsupported image unknown；回合仍 completed、模型答 UNAVAILABLE | 图片准备失败，不能以回合状态作为上传成功 |
| 伪通用 file 输入 | turn/start 返回 -32600 unknown variant file，列出的允许类型没有 file | 此协议不接受通用 file variant |

`thread/read includeTurns=true` 的恢复历史仍保留 A、B 对应 userMessage.localImage path。历史中有路径不证明宿主复制/长期保存了文件字节。未覆盖原始文件丢失、自动压缩后恢复、超过上下文窗口等生命周期条件。

## 可复核原始证据

目录 `/tmp/agent-team-attachment-verification/codex/`：

- `probe.mjs`、`create-extra.py`：探针/补充素材生成器。
- `expected.json`、`grid-expected.json`：期望值。
- `assertions.json`：12 组结果自动核对全部通过（含预期拒绝/不可读对照，不表示所有输入均可处理）。
- 各用例 `*.result.jsonl`：路由、回合状态、回答和工具摘要。
- 各用例 `*.jsonl` / `*.stderr`：实际双向协议和 stderr，data-url 日志含自制图片 base64。
- `resumed-history.json`：恢复后历史；`session.json` / `grid-session.json`：仅测试会话 ID。

临时文件可能被系统清理；本文记录结果，需复跑时重新生成随机素材。没有验证 PDF/DOCX/音频/大文件/所有模型；不应将 TXT 和 PNG 的成功泛化成任意附件格式支持。
