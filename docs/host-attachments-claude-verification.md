# Claude Code 宿主附件实际验证

日期：2026-10-31。宿主：Claude Code `2.1.215`。独立工作区及非敏感测试证据：`/tmp/agent-team-attachment-verification/claude/`。没有修改业务代码或用户配置；测试会话按 CLI 正常机制保存，以便跨进程恢复。

## 范围与方法

使用本机已有登录和默认模型，不改 provider 路由。每次调用设置 90 秒超时，工作目录为上述临时目录，禁用 hooks、slash commands，严格空 MCP 配置；仅工具读取用例启用 `Read`，原生图片用例 `--tools ''`。没有启用 Bash、Write、Edit、Agent 或 web 工具。

关键 CLI 参数：`-p --setting-sources user --settings '{"disableAllHooks":true}' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --permission-mode dontAsk --output-format stream-json --verbose --effort low`。

结构化输入使用 `--input-format stream-json --replay-user-messages`，stdin 为单行用户消息：`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]},"parent_tool_use_id":null}`。

所有图片用 Python 标准库生成随机排列色块；问题和文件名都不含答案。随机口令只写入 TXT/PDF，未放进问题。每项证据由 `<编号名称>.jsonl`、`.stderr`、`.summary.json` 组成；`probe.py`、`images.py`、`additional.py` 是探针。`expected.json`、`grid.expected.json`、`pdf.expected.json` 为独立期望值。

## 实际模型边界

全部用例的宿主初始化 `model` 为 `deepseek-v4-flash[1m]`，assistant 消息 `model` 为 `deepseek-v4-flash`。这证明的是**当前 Claude Code 入口和当前配置路由**，不是 Anthropic 所有 Claude 模型，也不证明其他 provider/模型支持。没有读取或记录凭证；没有通过模型自述判断模型身份。

## 用例与结果

| 编号/日志前缀 | 操作 | 实际结果 | 判断 |
| --- | --- | --- | --- |
| `01-read` | 只给 TXT 绝对路径，允许 Read | 观测到 `Read(file_path=.../sample.txt)`，准确返回随机 32 位十六进制口令 | 路径读取通过；这是工具读文件，不是原生 file 上传 |
| `02-no-tools` | 同样 TXT 路径，关闭所有工具 | 返回 `UNAVAILABLE`，无工具调用，未泄露口令 | 无工具对照通过；不能只传路径就承诺读文件 |
| `03-native-image` | base64 PNG 作为 image block，关闭所有工具 | 正确返回 4 个色块及顺序 `orange, red, blue, green`；replay 包含 image block，无工具调用 | 原生图片端到端通过 |
| `04-resume-without-image` | 新进程 `--resume` 原 session，只发文本 | 正确回忆前图色块；session ID 一致 | 续接通过，但单独此项可能利用前轮文字答案 |
| `05-resume-new-image` | 新进程 resume，同时传另一 PNG | 正确返回新图 3 个色块 `orange, red, blue` | 续接中新附件通过 |
| `06-image-via-read` | 只给 PNG 路径，允许 Read | 观测到 Read 图片，正确返回 4 色顺序 | 图片文件工具读取通过 |
| `07-corrupt-image` | base64 编码内容实际为 `NOT_AN_IMAGE`，声明 PNG | CLI 将 image 转为 `[Image could not be processed: ...]` 文本；模型报告不能处理，进程 exit=0、result subtype=success | 没有误认图片内容；**进程成功不等于附件成功，未产生结构化失败状态** |
| `08-missing-path` | 只给不存在 PNG 路径，允许 Read | Read 返回 `File does not exist`；模型如实说明缺失，无虚构图像内容 | 缺失文件可识别；result 仍 success |
| `09-grid-count-only` | 原生 PNG 为 3×4 随机色块，只问行列、不问颜色 | 回答 3 行 4 列，未回答颜色 | 为后续保留未披露视觉信息 |
| `10-resume-unanswered-visual-detail` | 新进程 resume `09`，不重传图，才问全部 12 格颜色 | 精确返回 `[[red,orange,green,blue],[red,blue,orange,orange],[blue,orange,orange,orange]]`，与独立期望完全一致，无工具 | **跨进程恢复仍可访问此前未回答的视觉细节**，比重复前轮文字答案证据更强 |
| `11-pdf-via-read` | 只给本地单页 PDF 路径，允许 Read | 首次 Read 回传 document；随后模型再次 `Read(...,pages="1")`，工具回传 JPEG 页面图，最终准确返回 PDF 随机口令 | **PDF 通过页面图像回退读取成功**；不能据此说原生 PDF 直传可用 |
| `12-native-document` | base64 PDF 作为 document block，关闭工具 | 没有返回口令；回答 unsupported document type、没有可用内容，exit=0、result subtype=success | **当前路由原生 PDF 未通过**，不能靠 CLI 成功判断附件成功 |

`03` 至 `05` session：`a625987f-4c2c-41f0-845c-0079c3e3d719`。`09` 至 `10` session：`7d4d5c09-7979-4da3-9d5f-cc00b1b1b6cb`。两轮恢复均由前一 CLI 进程退出后的新进程进行。

## 对项目的约束

1. 当前 `src/hosts/cli-hosts.mjs` 使用 argv 文本 prompt；要传原生图片必须增加结构化 stdin 路径。现有文本调用不能自动获得 image block 功能。
2. TXT、PNG、PDF 的本地路径读取依赖 Read。`src/hosts/policies.mjs` 的 communication 模式没有 Read；必须单独设计附件可读边界，不能绕开当前策略或从可用宿主推断所有模式可读。
3. 通用“附件发送成功”不能只看 exit code 或 `result.subtype=success`。坏图和不支持的 PDF 都能以成功结果收尾，但并未处理附件。
4. PDF 可通过 Read 页码提取后视觉识别；本次仅验证单页、简单英文口令，未覆盖扫描 PDF、复杂表格、加密 PDF、多页上限或其他格式。
5. 12 格视觉恢复通过说明此次会话保留了可用于后续问题的图片内容；不等同于无限期持久化、跨版本迁移或压缩上下文后的保证。
6. 本次没有大文件上限、并发、多附件顺序、文件权限拒绝、恶意格式、取消/中断或网络故障测试。未对整个模型目录逐一测试。

## 官方依据

- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)：结构化用户消息支持 base64 image block；用于构造原生图片探针。
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)：`--input-format stream-json`、`--resume`、`--tools`、`--permission-mode`；参数是否可用还用本机 `claude --help` 确认。

本报告以真实日志为能力结论，官方资料只说明输入形式与参数语义。
