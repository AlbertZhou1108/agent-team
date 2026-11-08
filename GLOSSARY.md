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

**External controller / 外部主控**:
A team controller owned by the user's existing host session rather than by the Agent Team host runner. It is not a member and not the Panel Agent; one principal may manage multiple teams.
_Avoid_: 外部成员、桌面助手

**Client binding / 客户端绑定**:
One revocable host connection of an external controller principal. It records the host, session identity, declared/probed capabilities and credential digest. Multiple bindings may share a principal, but only the active binding can hold a team's controller seat.
_Avoid_: 团队成员、Panel 会话

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

**Decision request / 决策请求**:
A structured request created when a headless-team member needs a user decision. It belongs to the team and external principal; the controller relays the user's answer and wakes the original member. The client card is only one possible presentation.
_Avoid_: 互动卡、授权门禁

**Turn / 回合**:
One framework-driven host run attempt, recorded separately from message numbers and host sessions. Member and Panel turns share one record shape and one state machine (`running / unknown / completed / failed / cancelled / stopped`).

**Charter / 团队说明**:
Optional plain text supplied at group creation and injected into every turn's context. It is context, not an authorization gate.

**Group policy / 群执行策略**:
`communication | read-only | workspace-write`, chosen at creation; ordinary member pair conversations run under it; ordinary member coordination/profile/private contexts always use communication. Panel Agent private access is configured separately. Maps to the two logical domains `communication` and `project`.

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

