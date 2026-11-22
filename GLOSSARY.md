# Agent Team

Glossary for the current communication-first framework. Process vocabulary from earlier revisions (Goal, Contract, Work Item, Preparation, Closing) is retired — do not reintroduce it in code or docs.

## Language

**Team / 群**:
A persistent communication space containing members, its Main Agent relationship, and messages. State is only `open` or `archived`.
_Avoid_: 已完成团队、当前团队状态

**Member / 成员**:
A permanent role identity bound to one host session set. Names stay reserved after removal.
_Avoid_: 用户(用户是群外的真人入口)

**Main Agent / 主 Agent**:
The current controller that receives formal reports and coordinates work in ordinary messages. It may be a lead member, the Panel Agent, or an external controller principal; one team has one active controller binding at a time.

**Controller takeover / 接管主控**:
An explicit transfer of a team's active controller seat to another controller conversation. The previous conversation becomes read-only, and the change is visible in team history.
_Avoid_: 同时控制、自动切换主控

**External controller / 外部主控**:
A team controller owned by the user's existing host session rather than by the Agent Team host runner. It is not a member and not the Panel Agent; one principal may manage multiple teams.
_Avoid_: 外部成员、桌面助手

**Client binding / 客户端绑定**:
One revocable host connection of an external controller principal. It records the host, session identity, declared/probed capabilities and credential digest. Multiple bindings may share a principal, but only the active binding can hold a team's controller seat.
_Avoid_: 团队成员、Panel 会话

**Desktop controller / 桌面主控**:
An External controller operated through a host's desktop application. It creates and directs teams but is never a Member, and it does not execute member work in its user-visible conversation.
_Avoid_: 桌面成员、桌面执行器

**Desktop controller conversation / 桌面主控会话**:
One user-visible conversation in a desktop application that acts as an independent External controller. A single desktop installation may contain several unrelated Desktop controller conversations, each able to control different teams.
_Avoid_: 桌面程序、窗口、成员会话

**Controller workspace / 主控工作目录**:
The current working directory of a Desktop controller conversation. Every team controlled by that conversation inherits this directory and follows later changes to it.
_Avoid_: 固定团队目录、主控独立目录

**Bundled execution engine / 内置执行引擎**:
A member-capable host runtime supplied by the same desktop application installation. It may execute member turns only in framework-owned sessions separate from the Desktop controller conversation.
_Avoid_: 桌面会话、用户当前聊天

**Desktop-ready host / 桌面可用宿主**:
A host family whose supported desktop installation provides both a Desktop controller connection and a usable Bundled execution engine. Missing either side makes that surface unavailable to the framework.
_Avoid_: 只接 MCP、只装客户端

**Agent Team activation / Agent Team 启用**:
An explicit action in a Desktop controller conversation that starts using Agent Team by invoking its Skill or requesting Agent Team work. Installation alone never activates a controller conversation.
_Avoid_: 安装完成、自动接管

**Native multi-agent / 原生多智能体**:
A host product's own subagents or team facilities. It is outside Agent Team coordination and does not become a Message or Member merely because the same desktop application is connected.
_Avoid_: Agent Team、团队消息

**Coordination session / 调度会话**:
The single serialized context where all member reports to the Main Agent are delivered.

**Pair conversation / 双人会话**:
An isolated two-member context; distinct pair conversations run concurrently.

**Conversation / 会话**:
The single context record behind both a member's endpoints and a Panel Agent session: one owner (member or Panel Agent), one `context` (coordination / `pair:<peer>` / private / profile / archive-summary), one host-session slot. Turns, history, inputs and delivery queues all reference it by `conversation_id`.

**Message**:
A record from one sender to one recipient (`send` wakes the recipient, `note` merges into the recipient's next formal input, `system` is framework notice). Message numbers are stable identities.

**External delivery / 外部投递**:
A durable event addressed to an external controller. The active binding claims it through `control_inbox`; claiming means the client accepted the input, not that the host completed business work.
_Avoid_: 已回复、已处理

**Active wake / 主动唤醒**:
An attempt to make an idle external controller host start a turn in its bound session. Active wake does not itself claim an External delivery.
_Avoid_: 外部投递、消息送达

**Wake state / 唤醒状态**:
The lifecycle of an Active wake: queued, started, failed, or unsupported. `claimed` belongs to External delivery, not Active wake.
_Avoid_: 投递状态、运行状态

**Pull-only / 仅拉取**:
A Client binding that receives External deliveries only when it calls `control_inbox`; it has no verified Active wake.
_Avoid_: 不支持投递

**Pull-only acceptance / 接受仅拉取**:
An explicit, auditable decision to use a Client binding through Pull-only for its existing and future teams until wake verification succeeds again. It grants no new permission.
_Avoid_: 自动降级、主动唤醒成功

**Verified active wake / 已验证主动唤醒**:
An Active wake capability only after a real wake has reached `started`; configuration existence alone does not verify it.
_Avoid_: 已配置主动唤醒

**Wake environment fingerprint / 唤醒环境指纹**:
The adapter-owned set of environment facts that determine whether a Verified active wake is still valid. A fingerprint change requires verification again; ordinary team changes do not.
_Avoid_: 团队配置指纹、服务版本

**Headless readiness / 无头就绪**:
The condition in which a headless team may receive work because its external controller has Verified active wake. A team that has not reached this condition is provisioning, not ready.
_Avoid_: 团队已创建、连接已配置

**Headless member model selection / 无头成员模型配置**:
Model and reasoning-effort selection made through the external control plane without panel UI; the selected values must come from the host's live catalog and never fall back silently.
_Avoid_: 面板模型设置、用户私有配置

**Decision request / 决策请求**:
A structured request created when a headless-team member needs a user decision. It belongs to the team and external principal; the controller relays the user's answer and wakes the original member. The client card is only one possible presentation.
_Avoid_: 互动卡、授权门禁

**Turn / 回合**:
One framework-driven host run attempt, recorded separately from message numbers and host sessions. Member and Panel turns share one record shape and one state machine (`running / unknown / completed / failed / cancelled / stopped`).

**Charter / 团队说明**:
Optional plain text supplied at group creation and injected into every turn's context. It is context, not an authorization gate.

**Group policy / 群执行策略**:
`communication | read-only | workspace-write`, chosen at creation; ordinary member pair conversations run under it; ordinary member coordination/profile/private contexts always use communication. `workspace-write` permits file changes only inside the team workspace, independently of whether shell tools are enabled; a host that cannot enforce that boundary cannot claim the policy. Panel Agent private access is configured separately.

**Member execution policy / 成员有效策略**:
The full effective capability of one member, not just a policy label: the model dimension (the live catalog facts of the member's current model — `inputModalities`, `contextWindow`, `reasoningEfforts`) intersected with the execution dimension (the Group policy ceiling × host enforcement × sandbox, e.g. `exec.read` / `exec.write` / `exec.shell` / `tool.browser`). It records the requested ceiling, effective mode, concrete capabilities, model summary and the reason for any safe downgrade; a fact the upstream does not declare stays `'unknown'` / `null` instead of being inferred. See [ADR 0014](docs/adr/0014-unified-member-capability-routing.md).
_Avoid_: 群策略、宿主默认权限、按 profile 推断能力

**Work dispatch / 派发工作**:
A message that may start a member turn, gated identically at all three entries: in-team `send`, Panel `team_send`, and headless `team_send`. It may declare `requiredCapabilities` / `minContextWindow`; the gate checks the target member's current capability card before the message is recorded, and re-checks it against the latest model selection, live catalog and effective policy just before the turn starts. Missing or unknown requirements are rejected conservatively, and a rejected dispatch is never silently rerouted to another member.
_Avoid_: 普通留言、所有团队消息、按正文猜需求

**Capability degradation / 能力降级**:
A previously available capability becoming unavailable after creation or after a dispatch was accepted — a mid-queue model switch to a weaker model, an unprobed or changed model catalog, a directory change that invalidates the member's directory-bound session, or a narrowed Group policy. The pre-execution re-check intercepts the affected messages before any host turn starts and notifies the Main Agent; satisfied messages in the same batch continue, existing work keeps its host outcome, and the framework never substitutes a fallback model, a wider permission, or another member.
_Avoid_: 自动换人、自动换模、权限恢复

**Capability escalation / 能力提升**:
An explicit user or controller action that increases a member's effective capability. A member's request may describe the need but never grants the escalation; changing to a stronger model is not a capability escalation.
_Avoid_: 成员自提权、模型升级

**Unknown runtime / 待核实运行**:
A turn whose outcome could not be verified (crash, restart). It blocks further delivery until the user resolves it. A delivery-safety state, not a business completion state.

**Archive / 归档**:
The archive switch (`groups.state`). Stops delivery; history is preserved and restore resumes delivery. Creates one fact snapshot, summarized on demand by Panel Agent; restore deletes the snapshot and its summary. Archive does not certify completion. Replaces the retired finish/closing semantics.

**Panel Agent**:
A local panel identity with one private user session, observer relations to every team, and optional main control (takeover/handback) of a team's coordination.

**Directive / 用户指令**:
A user statement sent through the trusted entry (`/direct`, panel input) with a persistent idempotent operation number.

**Panel private access / 私人访问范围**:
The Panel Agent private session uses `read-only | workspace-write | full-access`, independently of team policy. Its team coordination sessions remain communication-only.

**Task list / 任务列表**:
Each agent publishes its own task projection using doing/done/dropped. It communicates progress; it does not grant permissions or certify results.

**Note / 随心记**:
A private idea record, owned by the user rather than any team. Three states only: `active` / `done` / `archived`. It does not track execution and has no relationship to turns; handing a note to the Panel Agent just produces a prompt the user sends in their private conversation.

A note may carry a **source team** (`source_team_id`): the team context it was written in. Source is a historical fact used for display and filtering — not ownership. It never cascades (deleting a team leaves the note), never grants access, and never enters the prompt. A source whose team no longer exists shows as 团队已删除.
_Avoid_: 待办卡片、想法任务、笔记状态（不要给它加执行状态）、归属团队（来源不是归属）


**Plugin / 插件**:
An optional, self-contained panel feature (e.g. 全局搜索, 随心记) that declares where it appears through **mounts** (`left-nav` entry, `right-tools` block). The user may disable a whole plugin or hide individual mounts; disabling one must leave core panel work (conversations, team management, settings, Panel Agent) intact, and every entry it contributes (navigation, search entries, hotkeys) disappears with it. Built-in plugins ship with the app and cannot be uninstalled. Code identifiers live in `web/src/plugins` as `Plugin*` (localStorage retains the toolModules key for compatibility).
_Avoid_: 工具（与 Agent 可调用的工具面 `src/tools/` 撞名）、扩展、模块
