# 宿主附件能力验证报告

日期：2026-10-31。以本机真实推理为依据；未开发附件功能，未改适配器、框架、前端或用户配置。本次工作不影响此前已有的未提交 UI 改动。

## 总结

三个宿主存在可用的图片读取路径，但能力入口、模型路由和权限条件不同，不能统一解释为“上传任意文件都可用”。

| 能力 | Codex 0.158.0 | Claude Code 2.1.215 | DSH 0.2.0-rc.2 |
| --- | --- | --- | --- |
| 实际观测路由 | gpt-6.1-sol / custom | assistant.model deepseek-v4-flash | 请求 deepseek-official / deepseek-flash |
| TXT 路径工具读取 | shell 读取通过 | Read 通过 | read 通过 |
| 禁用工具的 TXT 路径对照 | UNAVAILABLE | UNAVAILABLE | 无读取，但回答出现伪工具文本 |
| 只给图片路径 | 禁用 shell/view_image 后不可读 | Read 读取通过 | headless read_image 通过 |
| 原生图片输入、无文件工具 | app-server localImage 与 image data URL 通过 | CLI stream-json base64 image 通过 | ACP deepseek-flash 通过；默认 ACP deepseek-v4-flash 拒绝 |
| 重启进程后恢复旧图 | 可答首轮未问过的六格颜色 | 可答首轮未问过的十二格颜色 | ACP 新进程恢复可答首轮未披露的六色顺序；headless 首次 TRANSPORT 后重试成功 |
| 恢复会话传新图 | 通过 | 通过 | 未统一验证 |
| 通用原生 file / PDF | file variant 真实请求被拒绝；未验证 PDF 工具链 | 原生 document 当前路由不通过；Read pages=1 转图片后 PDF 通过 | headless 无结构化附件参数；最简 PDF 仅源码 ASCII 可读 |
| 损坏图片/不存在文件 | 模型说不可用，但回合仍 completed；坏图 stderr 有准备失败 | 工具或 CLI 能说明失败，但 result 仍 success | 工具返回明确 error |

“路由”来自协议/请求观察，不是模型自述，也不证明第三方网关背后的实际物理模型。不能将当前 Claude Code 路由测试解释为所有 Anthropic Claude 模型能力；也不能把 DSH 两个不同路由的能力混为一谈。

## 方法和证据强度

- 使用自制、非敏感、随机内容；绝对路径和问题不包含答案。生成 TXT、PNG、简单 PDF。
- 每个宿主使用独立临时工作区、独立测试会话、调用超时，禁用外部 MCP 与无关工具。已有登录仅用于正常推理，无凭证读取或用户配置变更。
- 文件正例必须观测到读取工具，并核对随机口令；禁用工具对照确认“收到路径”本身不是文件读取。
- 原生图像正例关闭文件工具，核对随机视觉信息；Codex 和 Claude 另以“首轮只问行列、进程退出后才问颜色”排除仅复述旧文字答案。
- 成功状态和内容正确分开判断；坏图可导致正常退出/成功回合，因此不能以此作为附件处理成功判据。
- 原始日志/探针/素材位于 `/tmp/agent-team-attachment-verification/{codex,claude,dsh}/`，临时目录可能被系统清理。Codex config/read 配置响应已从保留日志中移除，证据只保留测试所需信息。
- DSH 部分初始测试按宿主默认机制保存自制图片副本，后续改用隔离附件目录；未清理共享用户存储，详见分报告。

## 对后续实现的影响

1. 必须区分“本地文件供工具读取”和“原生图像输入”。宿主类型不足以决定附件能力，至少还要考虑入口、所选模型/提供方和工具权限。
2. Codex 可直接沿现有 app-server 协议传图片；Claude 当前 argv 文本入口需改为结构化 stream-json 才能传原生图片；DSH 当前 headless 文本入口可通过 read_image 读图，但无文件工具的原生图像需要 ACP 等结构化入口。
3. communication 模式禁用文件工具。路径方案不能绕过此限制；本次原生图片成功也不意味着任意工具权限都应开放。
4. 普通文件按格式能力处理，TXT 成功不证明 DOCX/XLSX/PDF/音频可用；本次不支持作出“通用原生文件附件”承诺。
5. 生命周期需保留持久素材和附件标识。恢复后能够回答视觉细节是本次实测结果，不代表可以删除原始文件或保证上下文压缩后仍可读。

尚未验证：所有模型组合、文件大小和数量上限、长时间会话/上下文压缩、加密/复杂多页 PDF、DOCX/XLSX、音视频、并发上传、中断重试和完整 Web 上传链路。本报告是宿主入口能力验证，不是附件功能验收。

## 分项报告

- [Codex 详细实测](host-attachments-codex-verification.md)
- [Claude Code 详细实测](host-attachments-claude-verification.md)
- [DSH 详细实测](host-attachments-dsh-verification.md)
- [前期接口核查](host-attachment-capabilities.md)
