# Agent Team

Local teams are persistent communication spaces in which Agents carry out one or more contract-bounded goals.

## Language

**Team**:
A persistent space containing members, its Main Agent relationship, messages, and a history of goals; an open Team can communicate even when no Goal is executing.
_Avoid_: 群、已完成团队

**Goal**:
A contract-bounded execution cycle managed by the Team's current Main Agent, with its own work items, evidence, outcome, and terminal state.
_Avoid_: 任务、团队状态

**Current Goal**:
The active or finalizing Goal of a Team; a Team has at most one Current Goal.
_Avoid_: 当前任务、当前团队状态

**Goal Draft**:
An editable, uncommitted draft of a future Goal; it can be confirmed into a Queued Goal or deleted.
_Avoid_: Goal Proposal、排队 Goal

**Goal Queue**:
The user-ordered collection of confirmed Goals waiting to become Current; the first eligible Goal may be activated while ineligible Goals remain queued.
_Avoid_: 任务列表、Goal Draft 集合

**Queued Goal**:
A confirmed Goal waiting for activation; it retains its user-controlled queue position while ineligible, cannot be edited or returned to a Goal Draft, and can be canceled.
_Avoid_: 待执行任务、Goal Draft

**Goal Start Eligibility**:
The deterministic preconditions required to attempt a Goal; it does not predict whether the Goal will execute successfully.
_Avoid_: Goal 可行性、任务成功率

**Cancelled Goal**:
A confirmed Goal canceled before it starts; it is removed from the queue and never returns to a Goal Draft.
_Avoid_: 删除 Goal、未确认 Goal

**Team Charter**:
The persistent membership, workspace, and authorization boundary established when a Team is created.
_Avoid_: 团队模型策略、Goal Contract

**Goal Contract**:
The objective, scope, completion criteria, and capability subset for one Goal within its Team Charter.
_Avoid_: 团队契约、Goal 元数据

**Work Item**:
A concrete unit of work inside one Goal.
_Avoid_: 轮次

**Agent Turn**:
One host invocation for an Agent in a particular session.
_Avoid_: 目标、团队阶段

**Goal-bound Message**:
A Team message associated with one Goal; it may address the Main Agent or another Team member.
_Avoid_: 正式汇报、团队消息

**Goal Inbox Message**:
A Goal-bound Message addressed to the Team's current Main Agent.
_Avoid_: 汇报消息、主 Agent 消息

**Finalization Cutoff**:
The Team message sequence captured when a Goal enters finalizing; Goal Inbox Messages after it do not automatically delay completion.
_Avoid_: 关闭群聊、消息删除边界

**Consumed Goal Inbox Message**:
A Goal Inbox Message included in a Main Agent coordination turn that ended normally.
_Avoid_: 已阅读消息、已批准消息

**Model Strategy**:
A human-readable preference that guides model selection for newly created roles using the live host catalog and role responsibilities.
_Avoid_: 模型白名单、模型许可

**Model Catalog**:
The models and reasoning efforts currently reported by a host; its contents can change independently of a Team.
_Avoid_: 模型策略

**Model Assignment**:
The concrete host, provider, model, and reasoning effort persisted for a role when it is created.
_Avoid_: 模型偏好

**Main Agent**:
The current controller identity responsible for managing a Team's goals and coordination; this authority belongs to the Team rather than to an individual Goal.
_Avoid_: Goal 负责人、项目经理

**Main Agent Handover**:
The transition of a Team's Main Agent while its Current Goal remains unchanged; work is paused until the successor takes control.
_Avoid_: Goal 转移

**Panel Agent**:
The single user-facing coordination Agent for a data directory, with a private conversation; it may serve as the Main Agent of zero or more Teams. Its private conversation has a user-set workspace and a user-level file-effect access level, independent of Team contracts.
_Avoid_: 团队成员

**Panel Access**:
The user-level file-effect policy of the Panel Agent's private conversation: `read-only`, `workspace-write`, or `full-access`. It constrains project file writes and commands for that conversation only, never Team execution or Team write authorization.
_Avoid_: 团队契约、成员权限

**Archived Team**:
A Team that retains its history, Goal Drafts, and Goal Queue but accepts no new messages and starts no Goals; it can be restored and cannot be archived while a Current Goal exists.
_Avoid_: 已结束团队、已删除团队
