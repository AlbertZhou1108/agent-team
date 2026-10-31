# 消息附件最小实施计划

状态：可执行计划，2026-10-31。行为与接口设计见[消息附件最小设计](attachment-design.md)。

本计划供实现和独立检查 Agent 使用。除非某一阶段明确说明，前一步的完成标准全部满足后才能开始下一步。已有未提交 UI 改动属于用户，不得回滚、覆盖或在提交时混入本功能。

## 0. 基线和约束

开工前执行并记录：

```sh
git status --short
git diff --check
npm run check
```

若基线检查失败，先记录失败测试及与附件无关的原因，不能把它归因于后续改动。后续每个代码阶段至少运行该阶段列出的定向测试；最终运行完整 `npm run check`、`npm run build`。真实宿主测试仅在最终阶段手动运行。

Panel Agent 私人会话支持常见文本扩展白名单（UTF-8 校验）与 `.png`/`.jpg`/`.jpeg` 图片（签名 + 完整解码 + 像素上限），类型按扩展名在服务端判定，每条消息 0–4 个附件。普通团队继续使用纯消息；communication 权限和现有消息投递行为由回归测试保护。

## 1. 服务端附件设置

修改：

- `src/store.mjs`：创建 `attachment_settings(singleton=1, max_file_bytes, max_files, max_image_pixels, updated)` 单行表，并提供读取/更新方法。表不存在时读取默认值；首次保存时 upsert，不依赖通用 `app_settings`。
- `src/attachment-settings.mjs`（新建）：定义默认值 `5 * 1024 * 1024`、`4`、`20_000_000`，集中校验和序列化。
- `src/bus.mjs`：公开 `attachmentSettings()` 和 `updateAttachmentSettings()`。
- `src/http-api-routes.mjs`：增加 `GET/POST /api/settings/attachments`；沿用本地 Host/Origin/跨站校验，JSON 请求使用现有 `readJsonBody`。
- `web/src/shared/api/client.ts`、`web/src/shared/api/raw-types.ts`：增加设置读取/更新和类型。
- `web/src/features/settings/AttachmentSettings.vue`（新建）：三个带单位的数值输入和保存按钮；沿用 `Card`/`Field`/`Input`/`Button` 等现有组件及语义 token。
- `web/src/features/settings/SettingsDialog.vue`：在合适位置挂载该组件。
- `test/attachment-settings.test.mjs`（新建）：默认值、合法更新、NaN/负数/小数文件数/过大整数、持久化重建。

接口返回及更新请求固定为：

```json
{
  "maxFileBytes": 5242880,
  "maxFilesPerMessage": 4,
  "maxImagePixels": 20000000,
  "updated": "2026-10-31T00:00:00.000Z"
}
```

`POST` 必须同时收到三个正整数字段；允许一次更新全部字段，字段名不匹配或缺失整数时返回 `400`。前端将 MiB/MP 显示为友好单位，API 始终传字节/像素/个数。

完成标准：

- `npm run typecheck`、`node --test test/attachment-settings.test.mjs` 和现有 HTTP 路由测试通过。
- 页面刷新和服务重启后设置值不变；前端选择文件和后端校验读取同一份值。
- 修改设置不修改、删除或隐藏已存在消息。

独立检查：

- 检查 `attachment_settings` 只有一个 singleton 行。
- 直接提交 `0`、负数、NaN、无穷值、非整数附件数时均被服务端拒绝，不能只依赖前端。
- 原有模型策略、主题包和别的设置不因该表或 GET/POST 路由改变。

## 2. 附件模块和持久化

修改：

- `src/store.mjs`：增加 `attachments` 表及查询方法。列固定为 `id, panel_agent_id, original_name, media_type, size, storage_name, created_at, panel_message_id, ordinal`；为 `panel_message_id` 和 `panel_agent_id` 建查询索引。`storage_name` 只是 UUID 文件名。
- `src/attachments.mjs`（新建）：这是上传、验证、落盘、读取、绑定、回合输入准备和未发送清理的唯一模块。外部方法保持为 `upload(agentId, stream, metadata)`、`read(agentId, id)`、`discard(agentId, id)`、`bindTx(agentId, messageId, orderedIds)`、`prepare(agentId, orderedIds)`、`cleanup(now)`；其中 `bindTx` 只供 Store transaction 调用。路径解析和文件系统细节不暴露给 HTTP、PanelSessions 或 adapters。
- `src/bus.mjs`：实例化模块并提供薄转发；模块放在现有 Store 之后、PanelSessions 之前，不依赖 Bus 完成构造。`start()` 启动一次 best-effort cleanup，并以 1 小时 unref 间隔重复；`close()` 清除计时器。清理失败记录到现有服务器日志/错误输出，不影响通信启动。
- `web/src/shared/api/client.ts`：增加原始文件流上传、下载 URL 和安全错误解析。

附件模块必须执行：

- 根目录固定在框架数据目录 `<data>/attachments`（附件副本是框架数据，不进私人工作区，更换工作区不影响附件），目录 0700、文件 0600；与 Panel Agent 是否配置工作区无关。
- 原始文件名仅存数据库并用于 `Content-Disposition` 安全转义；存储路径只使用 UUID。拒绝 `..`、路径分隔符、NUL，不接受客户端 storage name。
- 上传边接收边累计字节、计算 SHA-256；超过 `max_file_bytes` 后立即停止并删除 `.part`。
- TXT 验证 UTF-8 且拒绝 NUL 和明显二进制控制字符；PNG 检查签名并通过图像库读取宽高、完整解码，拒绝超过 `max_image_pixels`。
- 完整写入并原子 rename 后再插入记录。DB 插入失败时删除最终文件。上传中/中断留下 `.part`，启动和定期清理。
- `cleanup` 只删除超过 24 小时且 `panel_message_id IS NULL` 的记录和文件；不能删除已绑定记录。清理与绑定通过 Store transaction/条件更新避免竞态。

如果项目当前没有可用于“完整 PNG 解码”的依赖，单独评估最小、成熟依赖；不得把只读 PNG 头当作完整图片验证。文本检查使用 Node 内置 API。

测试：新增 `test/attachments.test.mjs`，至少覆盖 UUID 落盘、同名文件不覆盖、文件权限、超限流中止、非 UTF-8、坏 PNG、超大像素、路径/符号链接拒绝、暂存过期清理、未过期不清理、已绑定不清理、绑定和清理竞态、写盘/DB失败清理。

完成标准：

- `node --test test/attachments.test.mjs` 通过。
- 模块测试接口就足以验证上述行为，不通过直接操纵内部 `.part` 命名或路径实现完成断言。
- 临时目录测试结束清理；测试失败输出不含附件字节或用户信息。

独立检查：

- 搜索所有文件的存取位置，确认上传文件只能经 `src/attachments.mjs` 操作。
- 扫描代码，确认浏览器 DTO 和日志不含绝对路径、`storage_name` 或 base64。
- 构造同名文件并确认生成不同 ID/物理文件。

## 3. 文件流 HTTP 路由

修改：

- `src/http-api-routes.mjs`：增加 `POST /api/panel-agent/attachments`、`GET /api/panel-agent/attachments/:id`、`DELETE /api/panel-agent/attachments/:id`。
- `src/server.mjs`：只补充二进制路由所需的响应处理。上传/下载路由自行写入 response；外层 JSON 包装只能在 `headersSent` 之前接管。
- `web/src/shared/api/client.ts`：上传使用 `fetch` + `ReadableStream`/File body，不读成 base64；下载返回 URL 或响应供组件使用。

接口固定：

- 上传请求体是单文件原始字节；`X-Agent-Team-Filename` 为百分号编码的原文件名，`Content-Type` 只能是 `text/plain` 或 `image/png`。
- 上传成功返回 `201`：`{ id, name, mediaType, size }`，不返回本机路径。
- 下载只允许该 Panel Agent 的附件；图片 `inline`、`image/png`；文本 `attachment`、`text/plain; charset=utf-8`。响应始终 `nosniff`，不执行上传的 HTML/SVG。
- DELETE 只允许未绑定附件，成功返回 `204`；已绑定或不存在统一 `404`，不能泄露其他 agent 的资源存在。
- 超限 `413`；不支持类型 `415`；内容/PNG像素无效 `422`；请求格式无效 `400`。错误 JSON 为稳定 `{code,error}`，前端显示 `error`。

修改 `test/panel-agent-http.test.mjs` 或新增 `test/attachment-http.test.mjs`，覆盖未配置工作区、成功上传、同名、下载限制、unknown DELETE、已绑定 DELETE、跨站/Cookie/Host 校验、超限、坏 PNG、二进制响应头和下载文件名。

完成标准：

- `node --test test/attachment-http.test.mjs test/http-routes.test.mjs test/panel-agent-http.test.mjs` 通过。
- 1 MiB 以上上传不在 `readJsonBody` 缓冲，不把原始字节写进 JSON 或日志。
- 请求中断后没有可发送附件记录；后续 cleanup 能移除临时文件。

独立检查：

- 直接调用路由，确认文件名不能插入 header/路径、错误响应不返回绝对路径。
- 检查 `response.headersSent` 分支没有二次 JSON 写入。
- 确认普通 API 错误与新增稳定错误码不会破坏现有前端。

## 4. Panel 消息幂等和附件绑定

修改：

- `src/store.mjs`：增加 `panel_message_requests(panel_agent_id, client_message_id, payload_hash, panel_message_id, created_at)`，唯一键为 `panel_agent_id + client_message_id`。
- `src/panel-sessions.mjs`：把 `panelPrivateTurn(text, activeTeamId)` 扩展为接收 `{ text, activeTeamId, clientMessageId, attachmentIds }`。可以增加一个内部辅助，但既有公共调用方必须由适配后的接口统一处理。
- `src/bus.mjs`：保持薄转发。
- `src/http-api-routes.mjs`：`POST /api/panel-agent/messages` 接收 `clientMessageId` 和有序 `attachmentIds`；缺 `clientMessageId` 时先保持旧客户端兼容，正式前端必须发送。
- `test/panel-agent.test.mjs`、`test/panel-agent-http.test.mjs`：增加幂等、附件查询和失败用例。

消息请求固定为：

```json
{
  "text": "请查看附件",
  "activeTeamId": null,
  "clientMessageId": "client-generated-uuid",
  "attachmentIds": ["attachment-uuid-1", "attachment-uuid-2"]
}
```

`clientMessageId` 由前端在首次提交前生成，结果未确认时跨重试保持不变；只有服务端明确确认后，下一条消息才生成新值。

提交顺序固定：

1. 计算正文和附件顺序的 `payload_hash`。
2. 同 `clientMessageId` 已存在：hash 相同则返回原请求及其消息/回复状态；hash 不同返回 `409`。
3. 否则在一个 Store transaction 中验证所有附件属于当前 Panel Agent、未绑定、未过期，创建用户消息，写入有序附件关联和 request 记录。
4. 提交成功后执行现有 `runPanelTurn`。宿主失败不回滚用户消息和附件；沿用现有 unknown runtime 恢复语义。
5. HTTP 结果未知后同一 clientMessageId 重试，不能再建消息、不能再触发第二条回合。

在 Store 实现 `panelAttachments(messageId)`，并在 `panelAgentState`/`panelBrowserState` 的 conversation rows 中加入 `attachments: [{id,name,mediaType,size,availability}]`。附件只通过结构化字段返回；`panel_messages.text` 保持用户原文。文件在执行时缺失则 `availability='missing'`，消息仍存在。

完成标准：

- 附件-only 消息成功，空正文且空附件失败。
- 同 ID 同 payload 重试返回同一 messageId；同 ID 改正文、顺序或附件集合返回 409。
- 用户消息先持久化；宿主模型再次收到附件 ID 和本地路径，附件不会静默丢失或退化成纯文本。
- 已绑定附件不能用于第二条消息；重启后历史行仍带相同附件元数据。
- 旧的无附件纯文本请求继续通过。

阶段检查：

```sh
node --test test/panel-agent.test.mjs test/panel-agent-http.test.mjs test/panel-access.test.mjs
npm run typecheck
```

独立检查：

- 模拟 HTTP 断开和结果未知后重试，检查只有一个 `panel_messages`、一个 request 行和一个 turn。
- 直接插入畸形/跨 agent/已绑定附件 ID，服务端必须在进入 host.run 前拒绝。
- 归档状态不用于 Panel 私人会话；不能误注册团队附件路由。

## 5. 三个宿主适配器

修改：

- `src/panel-sessions.mjs`：在执行前取得已绑定附件，调用 `attachments.prepare` 产生宿主内部输入；只向 `host.run` 传结构化 `context.attachments`，不把绝对路径拼进用户可见正文。
- `src/hosts/codex.mjs`：保留现有协议，在 `turn/start.input` 文本后附加 PNG `localImage`。TXT 仍通过现有允许的文件读取方式。执行前若附件不可用或能力不支持则明确报错。
- `src/hosts/cli-hosts.mjs`：Claude Code 首期使用现有文本 CLI + Read；DSH 保留 headless + read/read_image。两者都从 `context.attachments` 生成受控内部文件清单，不改变用户正文和现有会话恢复。
- `src/hosts/policies.mjs`：只在确有需要时补充“当前模式能否读取附件”的纯函数；普通团队 communication 权限不扩大。不要新增全局能力注册中心。
- `test/panel-agent.test.mjs`、`test/panel-access.test.mjs`、`test/codex-policy.test.mjs`：用 fake host 检查上下文传递、权限失败和附件路径不泄漏到浏览器消息。

精确能力边界：

- Codex PNG：`localImage`；TXT：仅允许文件读取的私人策略。
- Claude Code TXT/PNG：现有 Read 可读取的已验证组合。
- DSH TXT/PNG：headless read/read_image 可用且策略允许。
- 未知模型/入口：显示不支持原因，不自动切宿主、模型或提高权限。

不把 HTTP 成功、回合 `completed` 或模型自然语言声称“已读”当作附件处理回执。若宿主工具事件能明确关联失败，现有回合/history 中记录错误；不能确认时保持现有回合状态，不能显示“Agent 已理解”。不新增附件状态机。

完成标准：

- 定向单元测试通过，原有宿主策略、中断、会话恢复测试不退化。
- 发送前再次检查文件存在和大小；文件缺失给出明确错误，不悄悄只发文字。
- 未修改普通团队 communication 测试的预期。

阶段检查：

```sh
node --test test/panel-access.test.mjs test/codex-policy.test.mjs test/information.test.mjs
npm run check
```

`npm run check` 在此阶段运行，是为了尽早发现 adapter 变化对后端类型、lint 和既有 Web 类型的影响；真实模型调用仍留到第 7 阶段。

独立检查：

- 检查 adapter 从不自行构造存储根、校验上传或查询数据库，它们只消费准备后的附件输入。
- 检查日志、浏览器 JSON 和 prompt 可见正文无绝对路径；内部 adapter 输入可以包含路径。
- 审阅两个及多个附件在消息关联和宿主输入中始终按用户选择的顺序保留。

## 6. 前端上传与历史显示

修改：

- `web/src/stores/panel-agent.ts`：保存本轮附件 ID、名称、类型、大小和上传中/失败状态；发送和移除动作。可保留内存草稿，不要求刷新恢复未发送附件。
- `web/src/components/ai-elements/MessageComposer.vue`：通过附件列表和 `attach/remove` 事件扩展，增加回形针与拖入区域；不复制输入框。
- `web/src/features/panel-agent/PanelAgentComposer.vue`：接入文件选择、上传、能力/限额提示。
- `web/src/features/panel-agent/PanelAgentPanel.vue`：发送时传正文、附件 ID、稳定的 clientMessageId；成功清空本次草稿，失败保留。
- `web/src/features/messages/adapters.ts`、`web/src/shared/models/view-types.ts`、`web/src/components/ai-elements/ConversationMessage.vue`：将结构化附件映射到用户消息；图片预览、文件下载和 missing 状态。
- `web/src/features/settings/SettingsDialog.vue` 与首个设置阶段的新组件：最终检查设置保存及刷新行为。

交互完成标准：

- 可点选或拖入 TXT/PNG；每个文件显示名称、大小、上传中/可发送/失败、移除。
- 上传中或失败时发送禁用；移除失败文件后可发送剩余内容；只发附件时发送可用。
- 页面上传限制来自服务端设置；服务端拒绝时显示清楚错误，不修改草稿。
- 已发送用户气泡显示文字和附件；刷新页面、服务重启后仍能看到并访问。图片可在对话内预览，文本可下载。附件缺失保留卡片。
- 输入框折叠后仍显示附件数量及展开入口；键盘和读屏可操作。
- 普通团队 composer 不出现可用的上传入口；不得通过路径/URL 参数绕过 Panel 限制。

前端测试：更新 `web/src/stores/panel-agent.test.ts`；为 composer 状态和消息 adapter 增加必要的 Vitest。运行：

```sh
npm run typecheck
npm run test:web
npm run build
```

浏览器检查使用 `http://127.0.0.1:5173/agent`：

1. 上传 TXT 和 PNG，检查附件条及服务端限额。
2. 附件-only 发送；检查用户消息立即出现，回复出现后附件仍在。
3. 刷新页面；检查附件历史、预览和下载。
4. 模拟上传失败、移除、重新上传；确认不能绕过消息发送。
5. 切换模型/权限/工作区状态，检查不支持时提示且草稿不被删。
6. 设置页改限额后重新加载，检查前端限制和服务端拒绝一致。
7. 检查 1556×1344 和窄屏，确认不出现 overflow；键盘可移除附件、展开输入框。

独立检查：

- 用户消息气泡必须显示附件，不能只在输入框或工具轨迹中出现。
- 删除/刷新/失败不代表附件消失；missing 有明确提示。
- UI 不显示“Agent 已读取”，只显示可验证的已发送/失败状态。

## 7. 真实纵向验收和交付

在 fake host 单元测试通过后，按实现先后逐个接真实宿主。复用已有 `scripts/probes/attachment-*-vertical.mjs` 的素材和调用思路，但正式验收必须经生产上传接口、消息接口、真实 `Bus`/adapter，不能只复用探针网关绕过新代码。

每个宿主至少执行：

- 上传随机 TXT，发送，检查工具读取和正确随机内容。
- 上传随机 PNG，发送，检查正确视觉内容。
- 两附件同消息，检查顺序和用户消息历史。
- 服务完全重启后，从现有消息再次询问附件内容；必须看到重新读取事件或原生附件记录，不能只靠历史回答。
- 坏 PNG、文件缺失、错误/未知模型；检查明确错误及不静默降级。
- 附件-only，撤销/停止或网络失败；检查已有消息和附件不被静默删除。

阶段门禁：

```sh
npm run check
npm run build
git diff --check
```

人工运行真实宿主后，记录宿主版本、模型/提供方、策略、命令、结果和已知边界到 `docs/`。不得把手动真实模型探针加入普通 CI，以免消耗额度。

## 8. 独立审查清单

另一位 Agent 应按下列顺序检查，而不是只看实现自述：

1. 契约：实际请求/响应和 DOM 类型与本文一致，所有新增路径都有稳定错误；旧客户端/旧消息可用。
2. 生命周期：未发送清理、已发送保留、归档不动附件；无永久删除入口不应被提前实现。
3. 安全和边界：路径不可客户端控制；文件名安全；上传流限额；NOSNIFF；跨站/host 校验；不跨 Panel Agent 读取。
4. 幂等：重复提交不能双写/双调度；hash 冲突明确；未知结果可恢复。
5. 权限：Panel 文件读取不扩展到 communication 团队；未知模型路由不自动抬高权限。
6. 用户可见性：输入框附件、用户消息附件、刷新历史、下载/预览、缺失提示都能从 UI 观察到。
7. 测试真实性：区分 fake host 单测和真实宿主验收；看不到真实工具事件或原生附件证据时不能宣称通过。
8. 回归和卫生：`npm run check`、构建、定向 Web 测试、真实结果、临时文件与未追踪产物均记录；不夹带已有 UI 改动。

代码审查重点文件：

- `src/attachment-settings.mjs`、`src/attachments.mjs`、`src/store.mjs`、`src/panel-sessions.mjs`。
- `src/http-api-routes.mjs`、`src/server.mjs`、`src/hosts/codex.mjs`、`src/hosts/cli-hosts.mjs`。
- `web/src/stores/panel-agent.ts`、`web/src/components/ai-elements/MessageComposer.vue`、`web/src/features/panel-agent/PanelAgentComposer.vue`、`web/src/features/panel-agent/PanelAgentPanel.vue`。
- `web/src/features/messages/adapters.ts`、`web/src/shared/models/view-types.ts`、`web/src/features/settings/*`。

## 9. 明确延期

以下内容不从本计划进入实现：普通团队附件、文件复用/转发/去重、PDF/Office/音视频、远程宿主字节传输、DSH ACP 迁移、原生附件状态机、全局存储配额、历史附件永久删除、管理页面和文件迁移。出现相应需求时重新设计并单独验收。
