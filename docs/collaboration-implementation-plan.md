# Agent Team 协作机制实施与验收

日期：2026-10-21
状态：本地源码实施完成

依据：[产品概念](./concept.md)、[协作责任模型](./collaboration-concept.md)、[技术设计](./collaboration-technical-design.md)、[宿主执行策略](./host-execution-policies.md)。

## 1. 完成范围

| 能力 | 实现位置 | 结果 |
| --- | --- | --- |
| 建群前契约、版本化确认、幂等建群 | `src/collaboration.mjs`、`src/cli.mjs` | 完成 |
| 契约变更请求与可信用户决定 | Collaboration、RPC/CLI | 完成 |
| 多成员工作项、状态、revision、operationId | Collaboration、框架工具 | 完成 |
| 契约上限、工作项需求、角色收窄的有效策略 | Collaboration、Bus | 完成 |
| 逻辑策略域与宿主 session 持久绑定 | Bus、Adapter、SQLite | 完成 |
| 实际消息贡献与独立审查引用 | Collaboration | 完成 |
| 主 Agent 统一 coordination 调度 | Bus、Store | 完成 |
| 用户私聊和公开执行记录隔离 | Bus、Server、面板 API | 完成 |
| 三宿主沟通、只读、允许修改策略装配 | `src/hosts/*` | 完成 |
| Codex 原生子 Agent/wait 绕过防护 | Codex Adapter | 完成 |
| `active → closing → closed`、遗留消息处置、完成目标后保持群通信 | Collaboration、Bus | 完成 |
| 重启待核实、用户终止、持久最终交付 | Collaboration、Bus | 完成 |
| 契约、工作项、审查接受、收尾只读面板 | Vue 面板、HTTP API | 完成 |
| 核心规则、前端、类型和构建检查 | `test/`、`web/` | 完成 |

## 2. 实施中修复的关键问题

### 2.1 收尾可被未处理消息卡死

首次真实验收中，执行者和审查者仍有正式汇报等待主 Agent 处理时，`team_finish` 已进入 `closing`。此后普通消息不能再派发，而未处理消息又阻止 `closed`，团队永久卡在两者之间。

修复：收尾事务先计算未处理正式消息，要求 `dispositions` 完整覆盖；遗漏时返回精确 `seq:messageId` 并拒绝改变团队阶段。通过后才原子写入处置、`closing` 和最终交付。

### 2.2 Codex 原生 wait 工具阻塞团队回合

第二次真实验收中，主 Agent 尝试调用 Codex 原生 `wait` 协同工具，使 coordination 回合长期驻留等待，而框架设计的唤醒机制是结束回合后由新消息启动下一次运行。

修复：

- 调度规则明确团队等待由框架负责；
- Codex App Server 事件流检测到 `collabAgentToolCall` 时立即中断宿主回合并返回明确失败；
- 增加适配器级回归测试，确保该路径快速失败而不是等待到宿主超时；
- 验收指令不再要求 Agent 使用阻塞等待。

### 2.3 面板运行数跨群污染

已完成目标的群打开协作页时，标题使用了全局运行 endpoint 数，会显示其他群正在运行。修复为只统计当前群 endpoint。

### 2.4 主 Agent错误继承契约权限

原实现把契约最大策略直接当作主 Agent coordination 的默认策略，导致 `workspace-write + allowShell=false` 的主 Agent回合被 Codex 拒绝，而执行者和审查者也被粗粒度地赋予同一项目权限。

修复：

- coordination、profile、private 默认 `communication`；
- executor/collaborator 使用工作项策略；
- reviewer 自动收窄为只读；
- 工作项单独保存 `allowShell`；
- 框架在写入工作项前校验参与宿主能力；
- Codex Adapter 使用 communication/project 两个稳定会话域，并持久保存绑定。

## 3. 验证

规则级：

- `npm run check`：通过；
- `npm test`：31 个 Node 测试、5 个前端测试通过；
- `npm run build`：生产面板构建通过。

真实宿主：

- `node --disable-warning=ExperimentalWarning scripts/verify-collaboration.mjs`
- 目录和数据库由脚本新建，不读取已有团队；
- 三个场景都使用 Codex 主 Agent、DSH 执行者、Claude 独立审查者；
- 场景一验证纯讨论、版本成果、独立审查、接受、剩余消息处置和正常关闭；
- 场景二验证真实文件执行、初稿审查、返工、最终复审、成果版本覆盖和关闭；
- 场景三验证必要证据缺失时保留 blocked、目标保持未完成、用户终止后真实停止；
- Codex 双策略域专项验证沟通 thread 与项目 thread 分别持久化，项目 thread 内完成只读写入拒绝和可写成功；
- 每个场景记录契约 hash、消息、工作项、策略、运行状态和最终结果。

本轮真实报告：

- 三宿主完整验收：`work/collaboration-acceptance-aTvTZQ/result.json`；
- Codex 双策略域专项：`work/codex-bus-domains-4iX5A3/result.json`；
- 三宿主策略分层探针：`work/policy-layering-ZlHDuA/result.json`；
- Codex 同 session/thread 切换边界探针：`work/session-policy-switch-Z8CLKI`、`work/codex-policy-matrix-LEeT1B`。

面板：

- 打开真实启动链接和 Cookie；
- 核对协作页、工作项、证据/审查、流转记录、最终结果和跨群运行数；
- 验证 API 和页面保持 GET-only、本地 Host/Origin 鉴权与私聊隐私边界；
- 在同一隔离数据上复核关闭后的最终交付和成员停止事实。

实际报告路径写在每次隔离目录中的 `result.json`，包括 `panelUrl`、场景状态、错误和结束时间。测试目录保留供复核，不进入 Git。

## 4. 边界

- 本次实施只改本仓库源码、测试、文档和 `work/` 下的隔离验收数据。
- 不迁移或修改已有团队数据，不恢复历史任务，不部署，不发布，不 Git 提交。
- 面板仅观测，不是聊天或审批入口。
- 宿主策略只证明已验证工具和执行入口的限制，不是整机或全网络绝对隔离。
- 桌面入口、其他宿主及宿主升级后的行为需要单独验证。

## 5. 策略分层实施结果

- `communication` 是默认有效策略，不再从契约最大策略直接继承。
- executor/collaborator 使用工作项策略，reviewer 自动收窄到 `read-only`。
- 工作项单独记录 `allowShell`，宿主能力不满足时在写入工作项前拒绝。
- 框架持久保存 endpoint 的策略域会话绑定，并在运行时记录 `framework.session_scope`。
- Codex 实测创建了两个 thread：沟通 thread 与项目 thread；项目 thread 内复用并切换只读/可写沙箱。
- Claude/DSH 的同一 session 可跨策略域复用，不强制拆成多个会话。
- 真实三宿主验收中，Codex 主 Agent为 `communication`，DSH 为 `workspace-write + allowShell=false`，Claude 审查为 `read-only + allowShell=false`。
