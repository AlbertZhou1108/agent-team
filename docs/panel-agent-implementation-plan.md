# Panel Agent 实施计划

日期：2026-10-22
状态：MVP 已实现并完成真实宿主验证；阶段 6（私人会话原生化）已实现（2026-10-24）

依据：[Panel Agent 设计](./panel-agent-design.md)。

## 1. 实施原则

- 先建立统一的 Actor、Session 和 TeamBinding，再接入 UI。
- 保持现有 CLI 和团队执行链路可用。
- 增量迁移 SQLite，不重写已有团队、消息和会话。
- Panel Agent 不进入普通成员表。
- 所有团队写入都绑定明确的 `groupId` 和当前 controller revision。
- 先完成服务端不变量和测试，再开放面板写入口。

## 2. 阶段 0：类型与模型验证

已完成的逻辑验证覆盖：

- 无 Panel Agent 时禁止团队写入；
- 惰性创建后已有团队自动观察；
- 准备草案未批准时不能创建团队；
- revision/hash 不匹配时批准失败；
- 运行中的团队拒绝接管；
- 同一 Panel Agent 可以主控多个团队；
- 交还后恢复观察状态。

验证通过后才进入正式实现。

## 3. 阶段 1：Actor、Session、Binding 基础层

交付：

- `PanelAgent` 全局身份；
- `ActorRef` 或等价机制，统一解析成员与 Panel Agent；
- 全局私人会话与团队 coordination session；
- `observer|main` 团队关系；
- 每团队唯一 active controller；
- 控制器切换 revision、幂等 operation 和追加记录；
- 现有成员身份兼容解析。

必须解决现有约束：

- endpoint 不能只依赖 `member_id`；
- `groups.lead` 不能继续作为唯一活动控制者来源；
- 待处理消息接收者可能不是普通成员；
- 团队来源名称需要同时解析成员和 Panel Agent。

完成条件：

- 旧团队数据迁移后行为和身份不变；
- 同一团队无法出现两个 active controller；
- Panel Agent 不出现在成员列表；
- 现有核心测试全部通过。

## 4. 阶段 2：Panel Agent 身份与观察

交付：

- 惰性创建与持久化；
- 宿主、模型和思考强度配置；
- 全局私人会话、turn 和模型观测；
- 自动观察当前数据目录全部团队；
- 按团队读取快照、消息、成员、协作记录和轨迹；
- 会话上下文信封与团队切换；
- 面板 Agent 页面无 Agent、创建中、可用和运行中状态。

权限检查：

- 所有团队工具必须包含 `teamId`；
- observer 调用写工具被拒绝；
- 私人聊天不能写团队共享消息；
- 跨团队结果保留团队标识与来源；
- 团队切换后旧回合不能绑定新团队。

完成条件：

- 无 Panel Agent 时现有面板完全可用；
- Panel Agent 重启后身份和私人会话恢复；
- 两个团队的上下文、游标和工具结果不会混用；
- 模型配置观测与真实请求一致。

## 5. 阶段 3：Panel Agent 创建团队

交付：

- 从私人会话创建 preparation；
- 复用现有契约、普通角色模型计划和确认流程；
- 面板内的版本化确认卡；
- 一次性确认授权；
- 创建成功后自动形成 `main` 关系；
- 创建失败时保留 preparation 和错误事实。

确认规则：

- 用户不需要输入 CLI 命令；
- 用户必须确认具体 revision/hash；
- 修改草案后旧授权失效；
- 模型不能自行批准；
- 双击或重试使用同一 operation 和 confirmation grant，返回原结果。

完成条件：

- Panel Agent 创建出的团队与 CLI 创建团队使用同一数据结构和协作规则；
- pending preparation 不产生团队；
- 批准后只生成一个团队；
- 旧团队原有创建方式保持可用。

## 6. 阶段 4：主 Agent 接管与交还

交付：

- 接管前安全状态检查；
- 原主 Agent 暂停；
- Panel Agent coordination 激活；
- 交还原主 Agent；
- Panel Agent 回到 observer；
- 控制权变更审计记录；
- 控制 revision 和并发冲突处理。

接管事务要求：

- 不允许活动回合、unknown 运行和未处理正式消息；
- 切换期间冻结团队派发；
- 原主 Agent 的私人会话、宿主 session 和历史保持不变；
- Panel Agent 不继承原模型或 coordination session；
- 失败时保持或恢复原主 Agent，不能出现无控制者状态。

完成条件：

- 运行中接管被拒绝；
- 接管后只有 Panel Agent 能执行 coordination 写操作；
- 交还后只有原主 Agent 能执行 coordination 写操作；
- 双方历史归属可核查；
- 中途失败不会产生双主控或团队失联。

## 7. 阶段 5：Panel Agent 页面与交互

页面状态：

- 未创建；
- 创建向导；
- 全局私人会话；
- 团队上下文；
- 运行中、可停止；
- 准备中；
- 等待批准；
- observer；
- main；
- 接管或交还处理中；
- 失败和待恢复。

界面要求：

- 首页以 Panel Agent 为主体；
- 全局会话持续存在；
- 显示当前团队上下文和关系；
- preparation 卡片展示版本、hash、差异和批准按钮；
- 接管与交还展示当前阻塞项；
- 团队页面继续保留现有只读观测入口；
- 所有确认动作都有明确标题、对象和影响范围。

## 8. API 与安全

- 扩展面板只读白名单为命名写操作，不开放通用 RPC。
- 每个写接口单独校验参数和权限。
- 所有确认动作使用一次性授权，绑定动作内容与 revision/hash。
- 面板继续限制本机 Host、同源请求和请求体大小。
- 不向前端暴露 endpoint key、宿主认证或 socket 控制凭据。
- 团队消息内容按不可信数据交给模型，不能作为授权依据。
- Panel Agent 工具不能批准自己发起的准备、接管或交还。

## 9. 数据迁移

- 新增表使用增量迁移。
- 已有团队默认没有 active Panel Agent controller。
- 创建 Panel Agent 时为当前团队补齐 observer 绑定。
- 不自动把 Panel Agent 提升为已有团队的主 Agent。
- 不创建隐藏成员。
- 不修改原主 Agent、成员、endpoint、消息或历史归属。
- 原型数据不进入 SQLite。

## 10. 验证矩阵

| 场景 | 预期 |
| --- | --- |
| 无 Panel Agent 写团队 | 拒绝 |
| 创建 Panel Agent | 仅创建一次并持久恢复 |
| 观察读取团队 | 允许 |
| 观察写团队 | 拒绝 |
| 上下文切换团队 | 新回合携带新 teamId |
| 跨团队并发主控 | 上下文和锁隔离 |
| 未批准 preparation 建团队 | 拒绝 |
| 过期 revision/hash 批准 | 拒绝 |
| 运行中接管 | 拒绝 |
| 安全状态接管 | 成功且旧主 Agent 暂停 |
| 交还 | 原主 Agent 恢复，Panel 回到 observer |
| 重启 | 身份、关系、会话、控制权一致 |

## 11. 完成定义

只有以下条件全部满足，Panel Agent 功能才算完成：

- 阶段 1 至阶段 5 的服务器不变量和 UI 均通过验证；
- 阶段 6（私人会话原生化）的数据库迁移、API、三宿主映射、UI 与测试均通过验证；
- Panel Agent 私人会话可按用户级三档权限运行，coordination 仍固定 `communication`；
- 旧 Panel Agent 迁移为 `read-only` 后私人聊天与 coordination 行为保留；
- 原有 CLI 创建和使用团队流程无回归；
- 新旧团队数据均能在同一面板读取；
- Panel Agent 可创建团队；
- Panel Agent 可观察多个团队；
- Panel Agent 可同时主控多个团队且上下文隔离；
- 接管与交还不会产生双主控或身份重写；
- 模型批准、接管和交还均依赖真实用户确认；
- 完整测试、真实宿主验证和重启恢复验证通过。

## 12. 当前验证

- 测试覆盖身份、关系版本、接管交还、跨团队隔离、准备批准、访问边界、结构化工作项命令和重启恢复。
- 真实 Codex 宿主使用 `DeepSeek Flash / low` 完成 Panel Agent 私人对话。
- 真实 Codex 宿主完成一次 `teams_list` 动态工具调用，回复与工具结果一致，私人输入未写入团队共享消息。
- 真实 Codex 宿主在 Panel Agent 主控团队中完成一次 `team_send`，发送者、目标团队和接收成员均正确，另一团队的共享记录没有写入。
- 真实 Claude Code `2.1.215` 使用 `haiku / low`（实际观测为 `deepseek-v4-flash / low`）完成两轮连续 Panel Agent 私人会话；第二轮复用同一 Claude session，并成功调用 `teams_list`，私人输入未写入团队共享消息。
- 真实 Claude Code 普通成员完成 `profile_set`，生成 235 字能力自述；普通成员和 Panel Agent 两处生成的 Claude MCP 配置均包含有效共享 socket。
- 真实 DSH `0.2.0-rc.2` 使用 `DeepSeek Flash / low` 完成 Panel Agent 私人对话。
- 真实 DSH 完成 `teams_list` 工具调用。
- 真实 DSH 普通成员完成 `profile_set`，生成了 376 字能力自述，没有出现工具加载错误。
- 2026-10-24：Codex 0.158.0、Claude 2.1.215、DSH 0.2.0-rc.2 的 `read-only` / `workspace-write` / `full-access` 三档文件效果策略完成真实宿主验证；映射、限制与证据见[Panel Agent 三档权限验证记录](./panel-agent-access-verification-20261024.md)。

## 13. 阶段 6：Panel Agent 私人会话原生化（2026-10-24）

依据：[Panel Agent 设计 §3.1/§4.1/§5.1/§6.1](./panel-agent-design.md) 与[三档权限验证记录](./panel-agent-access-verification-20261024.md)。

### 13.1 交付

- `panel_agents` 增加 `workspace`、`access`；迁移旧行为 `access='read-only'`、`workspace=NULL`。
- 创建/更新 API 校验工作区存在、非数据目录、宿主支持目标档位；`workspace-write`/`full-access` 要求工作区。
- 私人回合使用配置的 workspace + 访问级别；coordination 固定团队 workspace + `communication`。
- 私人回合记录 workspace/access；私有能力不构成团队授权。
- 私人会话在 `host`/`model`/`workspace`/`access` 变化时重建（保留聊天记录）；仅改名不重建。
- Codex、Claude、DSH 适配器实现三档等价映射，并提供 `supportsPanelAccess` 能力声明。
- 面板创建/编辑表单增加工作区与访问级别；运行页显示当前档位与工作区；旧 Agent 显示“请设置工作区”。
- 测试：迁移、API 校验、回合装配、coordination 不变、会话重建、适配器配置装配（fake CLI）、真实宿主复跑脚本与证据。

### 13.2 适配器实现要点

- Codex：`danger-full-access` 映射 `dangerFullAccess`；read-only/workspace-write 保持现有 thread/turn sandbox，shell 始终开启。
- Claude：`read-only` 使用 `Read,Glob,Grep,Bash` + `denyWrite:[workspace]`；`workspace-write` 必须给 Write/Edit 加路径规则；`full-access` 不启用 sandbox。
- DSH：`danger-full-access` 同时传给 sandbox-policy 与 permission preset；插件每次调用显式设置 session mode；工具裁剪把 write/edit/bash 纳入非 communication 档。
- 所有宿主 `approval=never`；不新增逐操作确认。

### 13.3 验收

- fake 宿主断言私人回合 `policy`/`workspace` 与 coordination 的差异，及档位变化只重建私人会话。
- 适配器配置单元测试锁定三宿主映射，特别是 Claude 的路径规则（防止 Write/Edit 绕过沙箱）。
- 真实宿主复跑 `work/panel-access-verify-20261024/` 探针，三档全部 PASS；宿主升级后重跑。
- UI：创建/编辑校验、旧 Agent 提示、运行中禁止改配置、档位徽标。

### 13.4 实现与验证结果（2026-10-24）

实现：

- `src/store.mjs`：`panel_agents` 增加 `workspace`、`access`；旧行迁移为 `read-only` 并重置私人会话绑定（保留聊天记录），coordination 绑定保留。
- `src/bus.mjs`：创建/更新校验访问级别、工作区（存在/目录/不在数据目录内）与宿主能力；私人回合使用配置的 workspace + access，coordination 固定团队 workspace + `communication`；host/model 重建全部 Panel 会话，workspace/access 只重建私人会话，改名不重建；私人指令写入工作区与访问级别。
- 适配器：Codex 映射三档 sandbox/sandboxPolicy；Claude 生成只读工具集合、workspace-write 路径规则与 full-access 无 sandbox；DSH 的 sandbox-policy/permission preset 支持 `danger-full-access`，插件显式设置 session mode 并把 write/edit/bash 纳入非沟通档；三宿主提供 `supportsPanelAccess`。
- 前端：`PanelAgentSetup` 增加工作区与访问级别；`PanelAgentPanel` 保存/回填/校验并在改模型时保留配置；`PanelAgentChat` 显示档位徽标、工作区与旧 Agent 工作区提示。

验证：

- `test/panel-access.test.mjs`：7 个测试覆盖配置校验、宿主能力拒绝、私人/coordination 回合差异、会话重建范围、旧数据迁移、三宿主映射与 DSH 补丁/插件。
- `npm run test:core`：129 通过；`npm run test:web`：56 通过；`npm run typecheck`、`npm run build` 通过。
- 产品级真实宿主冒烟（`work/panel-access-verify-20261024/product-smoke.mjs`）：三宿主 `read-only` 私人回合均成功，记录到配置的工作区/访问级别与实际宿主策略。
- 产品级 `workspace-write` 冒烟（`product-access-smoke.mjs`）：三宿主工作区内写入成功、工作区外写入被拒；Claude 的 `allowedTools` 已包含 `Edit(**),Write(**)`。
- 冒烟发现并修复：`executionPolicy` 曾丢弃 `access`，导致 Claude 退化为 plain `Write` 工具并绕过沙箱；现已保留 access 并加回归断言。
- 原始三档行为证据仍以[三档权限验证记录](./panel-agent-access-verification-20261024.md)为准；宿主升级后重跑。

## 14. 已知问题

### 14.1 批准 preparation 后 Panel Agent 自动继续

状态：已修复。

复现：

1. 用户在 Panel Agent 私人会话中要求创建团队。
2. Panel Agent 创建 preparation，并提交契约和角色模型计划。
3. 用户通过面板批准具体 revision/hash。
4. 框架成功创建团队，Panel Agent 获得 `main` 关系，前端切换到新团队上下文。
5. 团队中没有创建工作项、共享消息或 coordination 回合。
6. 只有用户再次发送“继续执行”后，Panel Agent 才开始执行。

原因：批准接口原子创建团队后只完成绑定；前端随后设置 `activeTeamId`，但没有创建持久化的“团队已批准，请继续”事件，也没有唤醒绑定到新团队的 Panel Agent 回合。Panel Agent 在等待批准时已经结束原回合，因此不会自行恢复。

修复：团队创建事务内写入 `kind=continuation` 的 `panel_updates` 事件，ID 由 preparation/revision/hash 确定；现有更新泵自动将它交给绑定新团队的私人回合。重复批准不会重复创建事件，私人会话忙碌或服务重启时事件保持待交付。

## 15. Panel Agent 流式回复

框架为 Panel Agent 回合建立内存草稿，接收宿主 `onTextDelta` 后累积文本并发布 SSE 事件。实时增量只发送新增片段；连接快照携带未完成草稿，重连不需要重新调用模型。最终返回值落库为正式助手消息后发送完成事件并删除草稿，面板重取状态后以正式消息替换临时消息。

Codex 使用 `item/agentMessage/delta`；Claude 开启 `--include-partial-messages` 并读取 `content_block_delta/text_delta`；DSH 的 invocation-only observer 拦截 `llm/stream` 原始 chunk，只转发普通对话的 `text-delta` 并过滤辅助模型调用，随后用 committed `text` 补发未发送后缀。没有文本增量的宿主仍按原路径只返回最终结果。

验证覆盖适配器增量、Bus 草稿累积、最终替换、SSE 连接与完成事件。真实 DSH 冒烟确认 live chunk 已进入 SSE；单次回复可能只形成一个较大的 chunk，这是宿主/供应商的交付粒度，客户端不会伪造更细的字符流。真实模型流式冒烟不纳入自动测试，避免每次回归产生模型费用。
