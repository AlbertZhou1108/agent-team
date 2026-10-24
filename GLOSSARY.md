# Agent Team

Glossary for the communication-first framework (ADR 0004). Process vocabulary from earlier revisions (Goal, Contract, Work Item, Preparation, Closing) is retired — do not reintroduce it in code or docs.

## Language

**Team / 群**:
A persistent communication space containing members, its Main Agent relationship, and messages. State is only `open` or `archived`.
_Avoid_: 已完成团队、当前团队状态

**Member / 成员**:
A permanent role identity bound to one host session set. Names stay reserved after removal.
_Avoid_: 用户(用户是群外的真人入口)

**Main Agent / 主 Agent**:
The member (or Panel Agent) that receives every formal report in the group's coordination session and coordinates work in ordinary messages.

**Coordination session / 调度会话**:
The single serialized context where all member reports to the Main Agent are delivered.

**Pair conversation / 双人会话**:
An isolated two-member context; distinct pair conversations run concurrently.

**Message**:
A record from one sender to one recipient (`send` wakes the recipient, `note` merges into the recipient's next formal input, `system` is framework notice). Message numbers are stable identities.

**Turn / 回合**:
One framework-driven host run attempt, recorded separately from message numbers and host sessions.

**Charter / 团队说明**:
Optional plain text supplied at group creation and injected into every turn's context. It is context, not an authorization gate.

**Group policy / 群执行策略**:
`communication | read-only | workspace-write`, chosen at creation; pair conversations run under it, coordination/profile/private contexts are always communication. Maps to the two logical domains `communication` and `project`.

**Unknown runtime / 待核实运行**:
A turn whose outcome could not be verified (crash, restart). It blocks further delivery until the user resolves it. The only retained "state machine".

**Archive / 归档**:
The archive switch (`groups.state`). Stops delivery; history is preserved and restore resumes delivery. Replaces the retired finish/closing semantics.

**Panel Agent**:
A local panel identity with one private user session, observer relations to every team, and optional main control (takeover/handback) of a team's coordination.

**Directive / 用户指令**:
A user statement sent through the trusted entry (`/direct`, panel input) with a persistent idempotent operation number.
