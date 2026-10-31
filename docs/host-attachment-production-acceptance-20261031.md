# 附件功能真实宿主生产路径验收记录

日期：2026-10-31。执行入口：`scripts/probes/attachment-production-acceptance.mjs`（手动运行，不进 CI，避免消耗真实模型额度）。

与此前 [宿主能力验证](host-attachment-verification-20261031.md)、[纵向验证](host-attachment-vertical-verification-20261031.md) 的区别：本次在附件功能**实现完成之后**，经**生产上传接口、生产消息接口（clientMessageId + attachmentIds）、真实 Bus 与三个宿主适配器**执行，不复用探针网关，不绕过任何新代码。数据目录为临时目录，不影响用户实例。

## 环境与模型

| 宿主 | CLI 版本 | 模型 | 策略 | 数据目录 |
|---|---|---|---|---|
| dsh | 0.2.0-rc.2 | deepseek-flash | 私人会话 read-only | 临时目录 |
| codex | codex-cli 0.158.0 | deepseek-flash | 私人会话 read-only | 临时目录 |
| claude | （CLI 版本读取超时记为 unknown） | haiku（目录中自动选择的低价模型） | 私人会话 read-only | 临时目录 |

每条消息携带服务端生成的 `clientMessageId`；附件经 `POST /api/panel-agent/attachments` 原始字节流上传，消息经 `POST /api/panel-agent/messages` 提交。

## 结果：三个宿主各 13/13 通过

| 检查项 | dsh | codex | claude | 说明 |
|---|---|---|---|---|
| uploadTxt / uploadPng | ✅ | ✅ | ✅ | 生产上传接口 201，随机内容 |
| txtRead | ✅ | ✅ | ✅ | 模型经文件读取工具返回与上传内容一致的随机码（证明真实读取，非编造） |
| pngColors | ✅ | ✅ | ✅ | 2×2 四色图，模型按行优先返回的颜色序列与生成时完全一致 |
| twoAttachments | ✅ | ✅ | ✅ | 一条消息先图后文，回复同时覆盖图片颜色与文本随机码 |
| historyAttachments | ✅ | ✅ | ✅ | 会话行携带结构化附件 DTO，顺序与提交顺序一致，availability=available |
| restartReread | ✅ | ✅ | ✅ | 服务完全重启后要求重读；回复同时含随机码与从未出现在对话中的 verify-line 数字——凭据式证明发生了重新读取，不是靠历史回答 |
| restartHistoryKept | ✅ | ✅ | ✅ | 重启后经 history 记录接口核对，附件元数据与 available 状态完整 |
| badPngRejected | ✅ | ✅ | ✅ | 坏 PNG → 422 invalid_content（PNG 签名无效） |
| unknownAttachmentRejected | ✅ | ✅ | ✅ | 未知附件 ID 发送 → 404 not_found，不进入宿主回合 |
| orphanUpload + missingFileRejected | ✅ | ✅ | ✅ | 上传后删除磁盘文件再发送 → 422 attachment_missing，且确认没有产生任何回合 |
| stopKeepsMessageAndAttachment | ✅ | ✅ | ✅ | 附件-only 发送中途 stop：用户消息与附件保留、文件仍可访问、回合落为非运行终态 |

## 已知边界

1. **图片格式**：本轮验证覆盖 PNG；JPEG 走相同的 `localImage`/`read_image`/Read 通路与校验管线（单元测试覆盖签名/解码/像素上限），未在本轮做真实模型颜色回读，风险低。
2. **GIF/WebP/HEIC、PDF/Office**：仍未放开——宿主对 `localImage`/`read_image` 的这些格式支持未验证，"传得上去读不了"比明确 415 更糟；验证后可在类型注册表直接扩展。
3. **重启重读的实现方式**：附件路径清单只随带附件的回合注入；重启后追问历史附件依赖宿主会话历史中留存的清单（dsh/codex/claude 三家会话恢复均验证可用）。若用户清空宿主会话（reset-session），旧附件路径不再可用，需在消息中重新附带文件。
4. **Claude CLI 版本**读取超时记为 unknown，不影响结论；模型为目录自动选择的 haiku。

## 结论

附件功能（上传校验、消息绑定、幂等、三个宿主的真实文件读取、失败路径、生命周期）在生产路径下按设计工作，未发现静默降级或数据丢失。§7 验收通过，附件功能整体交付。
