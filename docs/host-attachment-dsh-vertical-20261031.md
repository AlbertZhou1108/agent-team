# DSH 最小真实附件纵向验证（2026-10-31）

## 结论

**当前真实 DSH 适配器可以在 Panel Agent read-only 私人会话中，读取通过 localhost 临时上传入口保存的 TXT 和 PNG；项目服务及适配器重建后可重新读取同一附件。** 这是“HTTP 上传持久化 + 路径注入 + 真实文件工具读取”验证，不是原生附件协议、生产上传 API 或前端完成。

真实链路：独立 localhost 上传网关 → 工作区附件文件 → 项目 `/api/panel-agent/messages` → `Bus.panelPrivateTurn` → `runPanelTurn` → 真实 `createDshHost` → `dsh headless` → read/read_image → 项目 HTTP 响应与持久化消息。

原生 ACP 图片输入的宿主能力测试是另一条链路，见 [宿主能力实测](host-attachments-dsh-verification.md)；本次不改变生产适配器。

## 执行与证据

脚本：[attachment-dsh-vertical.mjs](../scripts/probes/attachment-dsh-vertical.mjs)。手动运行命令：

```sh
node --disable-warning=ExperimentalWarning scripts/probes/attachment-dsh-vertical.mjs
```

脚本使用前一轮生成的非敏感随机 PNG fixture：仓库内 `scripts/probes/fixtures/dsh-grid.png` 及 `dsh-grid.expected.json`（从本次随机测试素材原样保留）。每次运行新建数据目录与随机 TXT 口令；需要本机已有 DSH 登录。脚本是真实推理探针，不加入默认自动测试，也不应无意重复运行。

本次数据根：`/var/folders/02/x9_f87tx6pz9f62fm7ptn18m0000gn/T/attachment-dsh-vertical-oRiuc4`。

- `results.jsonl`：仅保留测试结果、tool_call/tool_result、模型选择与 final 的白名单日志。
- `expected.json`：随机口令及 PNG 期望；fixture 答案没有放进模型提示。
- `workspace/attachments/`：经 HTTP 上传后保存的随机 UUID 文件。
- `data/`：真实项目数据库、宿主 session/storage、每次调用 MCP/策略 patch；该目录内部是运行数据，可能含项目内部会话密钥，不作为报告或日志分发。
- 外层执行记录 `/tmp/attachment-dsh-vertical-run.log` 不含凭证或配置内容。

请求级观察路由为 `deepseek-official / deepseek-flash`、reasoningEffort high。本机 DSH 0.2.0-rc.2。没有把请求路由当成远端模型身份独立验证。

## 结果矩阵

| 用例 | 实际结果 | 证据 |
| --- | --- | --- |
| 上传 TXT | HTTP 201，持久化 51 字节，返回绝对路径与 SHA-256 | results upload 记录 |
| 上传 PNG | HTTP 201，持久化 6193 字节，返回绝对路径与 SHA-256 | results upload 记录 |
| TXT 首轮 | 项目 HTTP 200，真实 read 调用，准确返回 first 随机值 | case txt-initial，tool_result completed |
| PNG 首轮 | 项目 HTTP 200，真实 read_image 调用，准确答 2 行 3 列 | case png-initial，tool_result image/png 600×400 |
| 重建后 TXT | 完整关闭 startServer，重建真实 host 和 Bus，HTTP 200，再次 read 同一持久文件，准确返回 second 随机值 | case txt-after-service-rebuild；不是仅凭文字回答，日志证明再次调用工具 |
| 重建后 PNG | HTTP 200，再次 read_image 同路径，准确报告 purple/red/orange、blue/green/yellow | case png-after-service-rebuild；首轮回答未给颜色，且观察到重新读取 |
| 坏图 | 上传入口接受字节；read_image 返回 status:error，Unsupported or malformed image data；模型明确转述错误 | case bad-image。HTTP 200 表示会话完成，不代表附件解析成功 |
| communication 禁读 | 真实同适配器 host.run、新 native session、tools=[]、policy communication/allowShell false；无 tool_call，明确不能读取，未输出随机口令 | case communication-no-read-host-run |

communication 负例没有经过 panelPrivateTurn：当前私人访问级别仅 read-only/workspace-write/full-access，不能表达 communication，因此负例直接调用同一真实适配器。没有伪造宿主或改变生产权限模型。该负例同时明确要求不使用 MCP/命令；证据证明本次未读取，不泛化为整进程安全边界证明。

测试结束后服务与临时网关已关闭，进程退出 0。脚本后续只做了无行为语义变化的清理：删除无用局部变量、负例改为直接 factory 以避免白名单观察器重复记录 final；`node --check` 与 `git diff --check` 通过，没有因此重复消耗真实模型调用。

## 实现边界

- 上传网关仅验证用，独立 `127.0.0.1` 随机端口；1 MiB 限制，随机 UUID 文件名，内容类型由测试 header 决定；不提供生产认证、多租户隔离、完整 MIME 校验、过期清理或前端。
- 上传完成后由测试驱动将路径写进普通文本消息。没有改消息 schema，没有生产附件 ID，也没有测试原生图片 block 到项目适配器的传输。
- 文件位于 Panel Agent 私人工作区内；不能据此推断工作区外路径、远程宿主、不同权限、不同模型/提供方可用。
- PNG 文件由 read_image 转入宿主图像流程，可能在 DSH 默认附件存储保留自制测试图片副本。用户配置和凭证文件没有读取或修改；项目 host 会按现有实现生成运行期 MCP 配置。
- 重建后 TXT 的 second 虽未在首轮最终回答展示，但首轮 read 工具结果包含它；因此新问题本身不足以排除记忆。这里依靠**重建后确实发生新的 read/read_image 调用**确认重新读取路径，而不是把正确回答单独当作证明。
- 这次先验证纵向可行性，不据此提前决定适配器、框架持久化或 UI 方案。

复现整理：原始 PNG 和期望值已原样保留到 scripts/probes/fixtures，脚本仅改读取位置，不再依赖 /tmp 中的前置素材；未因此重复调用模型。
