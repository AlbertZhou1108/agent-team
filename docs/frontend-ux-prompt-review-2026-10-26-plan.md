# 前端体验与提示精简评审 — 实施计划

- 日期：2026-10-26
- 依据：`docs/frontend-ux-prompt-review-2026-10-26.md`（唯一输入，行号均已在源码逐一核对）
- 基线：HEAD `a5d0db6`，当前分支 `refactor/deload`
- 纪律：不重写框架、不换组件库、不做大范围重构、不做纯视觉重设计；不修改接口与数据结构；5 处必要确认一处不删
- 本计划只覆盖报告中 P0-1～P0-4、P1-1～P1-5、P2-1～P2-6、C10、C17，不新增报告之外的问题

## 一、总览表

| 任务 | 内容 | 批次 | 依赖 | 并行组 | 工作量 | 实机 |
|---|---|---|---|---|---|---|
| P0-1 | 输入区「发给谁」三说合一 | B1 | 无 | G1 | S（0.5d） | 是 |
| P0-2 | 设置草稿三段同义反馈合一 | B1 | 无（与 P0-3 共用 `SettingsDialog.vue:291`，同组顺序改） | G1 | S（0.5d） | 否 |
| P0-3 | 删 4 处同屏成功 toast | B1 | 无 | G1 | S（0.5d） | 否 |
| P0-4 | 单路流状态条件化 | B1 | 无 | G1 | M（0.5–1d） | 是 |
| P1-5 | 归档确认补恢复路径 | B1 | 无 | G1 | S（0.5h） | 否 |
| P2-1 | 任务面板文案去 `tasks_set` | B1 | 无 | G1 | S（0.5h） | 否 |
| P2-2 | 空团队侧栏句去重 | B1 | 无 | G1 | S（0.5h） | 是 |
| P2-6 | 核实停止描述去重 | B1 | 无（涉及 `PanelAgentPanel.vue:398`，与 P0-3 的 `:405` 同文件不同行） | G1 | S（0.5h） | 否 |
| P1-2a | 创建分支直删 / 更新分支 2s 短 toast | B1 | 无 | G1 | S（0.5h） | 否 |
| P1-2b | 8 处成功 toast 降级/文案缩短 | B1 | 无 | G1 | S（0.5d） | 是 |
| P1-3 | 侧栏常驻教学句 | B2 | 无 | G2 | S（0.5h） | 否 |
| P1-1a | 互动 toast 回答后撤销 | B3 | 无 | G3 | M（1d） | 是 |
| P1-1b | 互动 toast 同屏抑制 | B3 | 依赖 P1-1a（同一封装） | G3 | M（0.5–1d） | 是 |
| P1-4 | Modal 目录错误内联 + 过期请求防护 | B3 | 无 | G3 | M（1d） | 是 |
| P2-4a | 运行数量口径核对 | B4 | 无（须产品/主 Agent 确认） | 单独 | S（2–4h） | 否 |
| P2-4b | 同步时间去重 | B4 | 依赖 P2-4a 的口径结论 | 单独 | S（0.5–1h） | 是 |
| P2-3 | API Badge | B4 | 待产品确认 | 单独 | S（0.5h） | 否 |
| P2-5 | PanelAgentSetup 说明密度 | B4 | 无 | 单独 | S（1–2h） | 否 |
| C10 | 死代码 toast | B2 | 无 | G2 | S（0.5h） | 否 |

- 工作量合计：代码改动约 3.5–4.5 人日（不含实机验证；全部为纯文案、显示条件、toast 时长与局部 state，不涉接口/数据结构/组件库）。
- 最小可交付：B1（约 2 人日）即可落地报告中「第一批」全部 P0 + 4 项纯文案。

## 二、分批建议

### B1：P0 四连 + 可顺手文案（低风险，先行）
覆盖 P0-1、P0-2、P0-3、P0-4、P1-5、P2-1、P2-2、P2-6，以及 P1-2 中 P0-3 顺路的「创建分支直删」+「更新分支留 2s 短 toast」（`PanelAgentPanel.vue:284` 与 `:318` 相邻，避免一次提交内同一行附近改两次）。
- 单独分批提交；回归时 `git revert` 该次提交即可整体回退。
- 不放入本批：P1-2 其余 8 处降级（跨 3 文件、与 P0-3 删除点邻接，交叠越少 diff 越干净）。

### B2：P1 文案 / 短 toast / 侧栏 / 归档
覆盖 P1-2 剩余 8 处（`SettingsDialog.vue:226`、`GroupWorkspacePage.vue:668/677/700`、`MemberModelDialog.vue:113`、`PanelAgentPanel.vue:368/386/405`）、P1-3、C10。
- P1-2 与 P0-2/P0-3 有行级交叠（`:668` 是 P0-2 的删 description 点；`:405` 是 P0-3 的删 toast 点），必须在 B1 合并后才改，避免 diff 重复劳动。
- C10 与 P1-4 同在 `MemberModelDialog.vue`，但 B2 先改 `:104-106` 的死代码、B3 再改目录加载逻辑，两段互不重叠；若 C10 留到 B3，P1-4 的分支判断仍要感知 C10 是否已改（`if (!reset && !form.model) return;`），计划为在 B2 完成 C10，消除该交叉。

### B3：互动提醒 + Modal 竞态（唯一真正的行为改动）
覆盖 P1-1a（回答后撤销）、P1-1b（同屏抑制）、P1-4（内联 + 竞态）。
- P1-1 是报告 P1 里唯一的封装改动，测试文件 `interaction-notification.test.ts` 需同步更新；改动触达 3 个消费方（`GroupWorkspacePage.vue`、`PanelAgentPanel.vue`、`interaction-notification.ts`）+ 1 个测试文件。
- P1-4 的 `MemberModelDialog.vue` 与 B2 的 C10、P1-2（`:113`）同文件，间隔一个批次，避免同一文件两批叠改。
- 本批完成后应单独跑一遍 `web/` 全量单测。

### B4：待确认项（P2 剩余，可在 B1 前并行推进「确认」这一步）
覆盖 P2-4a（口径核对，纯确认不写码）、P2-4b（依口径结果）、P2-3（待产品确认）、P2-5。
- P2-4a 是唯一的前置确认工作，不依赖任何代码批次，越早发起越好；P2-3 同理。
- P2-5 与其他批次无文件交集（`PanelAgentSetup.vue` 未被任何批次触碰）。

## 三、串行链与可并行组

**必须串行的链（合并顺序依赖）：**
1. `SettingsDialog.vue:291-293` 是 P0-2 与 P0-3 的共用删除点 → 同批次（B1）内顺序执行，只删一次。
2. `GroupWorkspacePage.vue:668` 在 P0-2 删 description；P1-2 再把标题转 2s 短 toast → P1-2 必须在 P0-2 合并后动该行。
3. `PanelAgentPanel.vue:405` 在 P0-3 直删；P1-2 不再处理它（P1-2 只处理 `:368/:386`）→ P1-2 在 P0-3 之后合并即可。`:284` 与 `:318` 相邻，B1 内一起改，B2 不再触碰。
4. P1-1b（同屏抑制）依赖 P1-1a（封装返回 id + dismiss 能力）先行合并。
5. P2-4b 依赖 P2-4a 的口径结论。
6. B2 整体依赖 B1（P0-2、P0-3）合并；B3 与 B2 只在 `MemberModelDialog.vue` 有行邻接，靠 C10 归 B2 消解。

**可并行组：**
- **G1（B1 内部，可并行开发 / 单次提交合并）：** P0-1（`TeamDirectiveComposer.vue` + `MessageComposer.vue`，无其它任务触及）、P0-2、P0-3、P0-4（`MessageFeed.vue`，无其它任务触及）、P1-5（`GroupWorkspacePage.vue:1152`，与 P0-2 的 `:668` 不同行）、P2-1（`TasksPanel.vue`）、P2-2（`GroupSidebar.vue` + `TeamHome.vue`）、P2-6（`PanelAgentPanel.vue:398`）、P1-2a（`:284` 直删 + 2s）。
- **G2（B2 内部）：** P1-2b、P1-3（`PanelAgentSidebar.vue`）、C10。
- **G3（B3 内部）：** P1-1a；P1-4 可与 P1-1a 并行开发（不同文件），但共享「更新测试 + 单测全量通过」的合并门。
- **确认类并行：** P2-4a 的口径核对与 P2-3 的产品确认与所有批次并行（纯提问，不写码）。

## 四、测试影响与回归点

**已有测试：**
- 唯一涉及 toast 的测试是 `web/src/features/messages/interaction-notification.test.ts`。P0/P1-2/P1-5/P2 的删除与时长改动没有断言覆盖（报告结论：「成功 toast 无断言，回归成本低」）。
- P1-1 改封装后该测试必改：`notifyInteraction` 的签名变化（返回 id / 按 `interaction.id` 使用稳定 id、dismiss 调用点从函数内移到消费方）会使现有断言（`mocks.toast.mock.calls.at(-1)` 形状、`expect(mocks.dismiss).toHaveBeenCalledWith('notice')`）不成立。改法：断言 toast 首参为渲染函数 + 稳定 id 来源；断言「answered/cancelled 后调用 dismiss(id)」与「查询缺失/加载中不调用 dismiss」。

**建议补的测试（按优先级）：**
1. `interaction-notification.test.ts`：P1-1a 的 dismiss 语义（回答/取消后撤、加载中不撤）——必做，随 P1-1a 合入。
2. `MessageFeed` 相关：P0-4 新增「单路 + 思考开 → strip 状态文字隐藏」的浅渲染或组件测试（现状无 `MessageFeed*.test.ts`，新建成本约 0.5d；若时间不允许，可退化为 E2E 实机清单第 1 条）。P0-4 的 aria-live 变化属可访问性行为，静态测试难以断言，以实机为准。
3. `MemberModelDialog` 相关：P1-4 建议加「目录失败 → 内联错误出现 + 无 toast.error」「打开后立刻关闭/换成员 → 旧请求返回不写回」两条（需 mock `api.modelCatalog`；竞态测试用 deferred promise）。

**回归点：**
- P0-1：快捷键提示从常驻文本改 tooltip/sr-only → 键盘可发现性下降（实机清单 6）。
- P0-2：去掉 toast 后依赖页面内提示；长设置页滚动时「未保存提示」可能不在视口内 → 已知接受（报告结论）。
- P0-4：条件写错 → `showReasoning=false` 时唯一运行状态消失（最高回归风险，靠验收用例「关闭 → strip 仍在」卡住）。
- P0-3 + P1-2：删除/缩短成功反馈后，结果不在视口内的路径不可见 → 靠逐处验收点（结果即时翻转）+ 实机清单 2 兜住。
- P1-1b：抑制条件过宽 → 唯一提醒被误抑制；过窄 → 无改进。分两阶段收紧（先 route+session+锚点，再视口）。
- P1-4：竞态写回旧成员、重开残留错误 → 靠请求序号 + 关闭清空。
- 删除/改文案不涉及 store 结构、路由或 API，无数据迁移。

## 五、实机验证清单（按批次排）

**B1 完成后：**
1. aria-live 双播：单路流 + 思考展示开/关时，`MessageFeed.vue:255`（strip）与 `:277`（展开卡片）是否重复播报（P0-4）。
2. 空输入时发送按钮 disabled：快捷键 tooltip/sr-only 是否仍可发现（P0-1）。
3. 空团队 + 窄屏/侧栏折叠：删除侧栏句后主页空态是否仍完整可读（P2-2）。
4. `PanelAgentPanel.vue:368/:386`（B2 才改）以外，B1 范围内已改的 `:284` 更新分支 2s 短 toast 是否读得清、不遮挡（P1-2a 附带）。

**B2 完成后：**
5. 权限/状态翻转是否在操作视口内即时可见；2s 短 toast 是否读得清（P1-2b，报告「待实机验证」第 2 条）。
6. 2s 短 toast 在移动端/底部输入区是否遮挡（报告第 8 条，与上一条一起做）。

**B3 完成后：**
7. 互动 toast 同屏判断：正在看卡时是否弹、离开后是否仍弹、answered/cancelled 撤销是否误伤唯一入口（P1-1，报告第 3 条）。
8. MemberModelDialog 目录错误内联后的视觉位置与竞态（P1-4，报告第 5 条）。

**B4 完成后（若 P2-4b 删除 footer 同步时间）：**
9. 侧栏折叠/窄屏是否仍能看到最后同步时间（报告第 7 条）。

## 六、回滚策略

- **整体回滚：** 按批次（B1/B2/B3/B4）各一次提交，`git revert <batch-commit>` 即可整体回退；无数据迁移、无接口改动，无兼容层。
- **toast/文案单点回退：** 改动点全部可定位到行：
  - 删 toast → `git revert` 对应行，或恢复 `toast.success(...)` 原调用（原文案保留在 diff 与报告中）。
  - 时长 → 把 `duration` 参数改回原值。
  - 文案 → 恢复原字符串。
- **特殊说明：**
  - P0-1 的 tooltip 若实机发现可发现性不合格：先退回「常驻 span」原状，再议；不要叠第三处提示。
  - P1-1 回退需连同 `interaction-notification.test.ts` 一起 revert（封装与测试同一次提交）。
  - P1-4 的竞态序号是新 state，回退即删，无外部影响。
  - B2 依赖 B1 合并（`:668` 与 P0-2 重叠）：若 B2 需要回退而 B1 保留，`:668` 的短 toast 会退回到「长 description + 短标题」的中间态，可接受，或按 P0-2 的 diff 单独恢复。

## 七、附：逐任务执行细则

### P0-1 输入区把「发给谁 / 怎么发」说了三遍

- **目标：** 空输入区只保留一条收件人说明；快捷键改为按需发现。
- **涉及文件与行号：**
  - `web/src/features/messages/TeamDirectiveComposer.vue:33`（常驻「发送给 主 Agent」标签，保留）、`:43`（placeholder）。
  - `web/src/components/ai-elements/MessageComposer.vue:102-104`（常驻快捷键 span，删除）。
- **具体改动步骤：**
  1. `TeamDirectiveComposer.vue:43`：placeholder 改为「输入团队指令或追问…」（去「向主 Agent 发送」）。
  2. `MessageComposer.vue:102-104`：删常驻 span。
  3. 在 `MessageComposer.vue` 新增只读的 sr-only 快捷键说明（「Enter 发送，Shift + Enter 换行」），并给输入区/发送按钮加 `aria-describedby` 指向它（该组件没有现成的 Tooltip 用法，报告允许简化为 tooltip 或 sr-only；若用 tooltip，挂在发送按钮外围 `InputGroupAddon` 区域，不挂 disabled 按钮本身；若只做 sr-only，验收「发现性」改为聚焦读屏可达）。
  4. 不要动 `PanelAgentComposer.vue:29` 的 label/placeholder（报告未提及，不新增范围）。
- **前置依赖：** 无。
- **验收：** 空输入区只看到一条「发给谁」；快捷键可通过聚焦/悬停（或读屏）发现；窄屏不重复。
- **回滚/风险：** 恢复 span 一行即可；风险是快捷键可发现性下降（实机清单 6）。
- **是否需实机验证：** 是。
- **并行/串行：** G1。
- **工作量估计：** S（0.5d）。

### P0-2 设置草稿：一次「应用」触发三段同义反馈

- **目标：** 应用规则后无 toast；页面内「点保存后生效」与「保存」按钮是唯一反馈。
- **涉及文件与行号：**
  - `web/src/features/settings/SettingsDialog.vue:291-293`（删 toast）、`:437-439`（保留，页面内提示）、`:445-452`（保留，保存按钮）、`:719`（「确认」→「应用到编辑器」）。
  - `web/src/pages/GroupWorkspacePage.vue:668-670`（只删 description，保留短标题）。
- **具体改动步骤：**
  1. `SettingsDialog.vue:291-293`：删整个 `toast.success(...)`。
  2. `SettingsDialog.vue:719`：按钮文案改「应用到编辑器」。
  3. `GroupWorkspacePage.vue:668-670`：`toast.success('全局模型策略已保存', { description: '将用于新团队初始角色和已有团队新增角色' })` 改为不带 `description` 的 `toast.success('全局模型策略已保存')`。
- **前置依赖：** 无（P0-3 共用 `:291`，本批内顺序先改 P0-2）。
- **验收：** 应用规则后无 toast；「已切换到 X，点保存后生效」持续显示直到保存；按钮文案不暗示已生效；保存成功无长描述。
- **回滚/风险：** 恢复 toast 调用即可；风险是「应用到编辑器」被误读为最终保存（靠页面内提示兜住）；长设置页滚动时提示可能不在视口内（报告已知，接受）。
- **是否需实机验证：** 否（静态路径已核实）。
- **并行/串行：** G1，且 P1-2 依赖本项先合并。
- **工作量估计：** S（0.5d）。

### P0-3 删 4 处「结果已同屏可见」的成功 toast

- **目标：** 结果已即时可见的操作不再播报成功 toast；错误反馈不减。
- **涉及文件与行号：**
  - `web/src/features/panel-agent/PanelAgentPanel.vue:318`（模型按钮标签即时更新，删 `toast.success('Panel Agent 配置已更新')`）。
  - `web/src/features/settings/SettingsDialog.vue:291`（已在 P0-2 删，本项不再动）、`:322`（`toast.success('配置已删除')`，删除后行消失，删）。
  - `web/src/features/groups/CollaborationPanel.vue:51`（`toast.success('团队已恢复')`，归档徽章翻为「沟通开放」，删）。
- **具体改动步骤：** 逐一删除上述 toast 调用行；`SettingsDialog.vue:322` 只删 `toast.success(...)` 一行，保留 `refreshPresets()` 与 catch 分支。不要动 `PanelAgentPanel.vue:284/368/386/405` 与 `MemberModelDialog.vue:113`、`SettingsDialog.vue:226`、`GroupWorkspacePage.vue:677/700`（它们归 P1-2）。
- **前置依赖：** P0-2（共用 `:291`）。
- **验收：** 模型切换 / 删除配置 / 恢复团队后结果立即可见，无重复播报；失败路径仍有错误 toast（对应 catch 保留）。
- **回滚/风险：** 恢复删行即可；无测试断言，回归成本低。
- **是否需实机验证：** 否。
- **并行/串行：** G1，P1-2 依赖本项先合并。
- **工作量估计：** S（0.5d）。

### P0-4 单路流状态条件化

- **目标：** 单路 pending + 正文空 + 思考展示开时，同屏只出现一处「思考中」。
- **涉及文件与行号：**
  - `web/src/features/messages/MessageFeed.vue:118-124`（`expandedStream` computed）、`:255-271`（strip/chip 渲染）、`:279-284`（展开卡片 + `ReasoningBlock`）、`:44`（`ReasoningBlock.vue` 内的「思考中」文本，注意该文件的 `:44` 即报告所指）。
  - `web/src/stores/preferences.ts:17`（`showReasoning` 默认 true；注意报告写 `preferences.ts:17`，实际文件在 `web/src/stores/preferences.ts`）。
- **具体改动步骤：**
  1. 定义「同屏已展示」条件：`streamingViews.length === 1 && expandedStream != null && preferences.showReasoning && pending && !message.text`（即报告「仅单路且 expandedStream 可见」的完整形式）。
  2. 该条件成立时：隐藏 strip 内 chip 的状态文字（`:268`），保留 `aria-live` 区域本身（`:255`）；或整体隐藏 strip。二选一，优先「隐藏 strip 内的状态文字」，保留 chips 容器不动，避免多路切换时的结构跳变。展开卡片（`:279-284`）与 ReasoningBlock 状态保留。
  3. 多路（`speakingStrip.length > 1`）与 `showReasoning=false` 分支保持现状——注意 `ReasoningBlock.vue:28` 的 `v-if="preferences.showReasoning"` 决定了思考展示关闭时展开卡片没有状态文字，此时 strip 是唯一运行状态，无条件不得删。
- **前置依赖：** 无（MessageFeed 不被其他任务触碰；`ReasoningBlock.vue` 若无改动则不在 diff 内）。
- **验收：** 单路 + 思考开 → 同屏只有一处「思考中」；关闭 → strip 仍在；多路 → chips 仍可点选。
- **回滚/风险：** 还原条件即可；条件写错会导致关闭思考后没有任何运行状态（最高回归风险），验收用例必须覆盖。
- **是否需实机验证：** 是（视觉与读屏；实机清单 1）。
- **并行/串行：** G1。
- **工作量估计：** M（0.5–1d）。

### P1-1 互动提醒：先修「回答后不消失」，再做同屏抑制

- **目标：** 新互动 toast 在回答/取消/失败后撤销；正在看卡不弹。
- **涉及文件与行号：**
  - `web/src/features/messages/interaction-notification.ts:4-17`（`notifyInteraction`，目前算了 `id` 但未 return，`:5` 的 `toast.dismiss(id)` 只在点击导航时用）。
  - `web/src/pages/GroupWorkspacePage.vue:292-322`（watcher 只处理新增 pending，无撤销）。
  - `web/src/features/panel-agent/PanelAgentPanel.vue:413-436`（同构 watcher，两处代码重复，无撤销）。
  - `web/src/features/messages/InteractionCard.vue:104`（DOM id `interaction-${id}`，可作锚点判断）、`:74-75`（答复后仅 refresh）。
  - 测试：`web/src/features/messages/interaction-notification.test.ts`（必改，见下）。
- **具体改动步骤（按报告优先级）：**
  1. `interaction-notification.ts`：`notifyInteraction` 返回 toast id（`return id;`）。
  2. 新增共享轻量映射（如 `notifiedInteractions: Map<interactionId, toastId>`，放 `interaction-notification.ts` 或小 store）：`notifyInteraction` 时登记，并提供 `dismissInteractionNotification(interactionId)`。
  3. 两个 watcher（`GroupWorkspacePage.vue:292-322`、`PanelAgentPanel.vue:413-436`）增加对 `rows` 中 `state !== 'pending'`（answered/cancelled/failed）的分支：若映射里有该 id → `dismissInteractionNotification(id)` 并移除映射。注意查询缺失/加载中（`data === undefined` / `isPending`）不得当作已回答。
  4. P1-1b：在 `notifyInteraction` 调用前增加同屏判断——`route.name` 为卡片所在页、`selectedSession`/目标 endpoint 匹配、`route.query.interaction === item.id` 且锚点已加载（`InteractionCard.vue:104` 的 DOM id 可用 `document.getElementById(\`interaction-${id}\`)` 存在来判定）同时满足才跳过；任一不满足就弹（此时 toast 是唯一入口）。第二阶段可选收紧到 `IntersectionObserver` 视口可见。先做第 4 步的宽松版，实机验证后再收紧。
  5. 更新 `interaction-notification.test.ts`：签名与 dismiss 断言随封装变化同步改；补「answered/cancelled 后 dismiss(id)」与「加载中不 dismiss」两条。
  6. 报告第 3 点（`Infinity→15s`）标为可选产品决策，需要时发产品确认，不在本计划内直接实施；若做，保留侧栏角标兜底。
- **前置依赖：** 无（封装改动为本项自身）；P1-1b 依赖 P1-1a 合并。
- **验收：** 回答/取消后 toast 消失；查询加载中不误撤；正在看卡不弹、离开仍弹（实机清单 7）。
- **回滚/风险：** 与测试文件同一次提交，revert 同退；P1-1b 可能误抑制唯一提醒（分两阶段收紧）。
- **是否需实机验证：** 是。
- **并行/串行：** G3。
- **工作量估计：** M（1d + 0.5–1d）。

### P1-2 9 处成功 toast 降级 / 条件保留

- **目标：** 结果可见但存在视口/权限/跳转不确定性的成功 toast，降级为 2s 短 toast 或只删重复 description。
- **涉及文件与行号：** `PanelAgentPanel.vue:284/368/386/405`、`MemberModelDialog.vue:113`、`SettingsDialog.vue:226`、`GroupWorkspacePage.vue:668/677/700`。
- **具体改动步骤（逐处，照做）：**
  1. `PanelAgentPanel.vue:284-286`：拆分支——`wasExisting` 时保留 2s 短 toast「Panel Agent 配置已更新」（`duration: 2000`，或 `toast.success(..., { duration: 2000 })` 视现有 toast 封装写法）；新建时直删（面板立即刷新可见）。此步与 P0-3 的 `:318` 同文件，注意 B1 合入后的行号偏移。
  2. `PanelAgentPanel.vue:368`（接管）：保留 2s 短 toast（保留文案 `Panel Agent 已接管 ${team.name}`）。
  3. `PanelAgentPanel.vue:386`（交还）：保留 2s 短 toast（保留文案 `已交还 ${team.name}`）。
  4. `PanelAgentPanel.vue:405`：B1 的 P0-3 已删，本项不再处理。
  5. `MemberModelDialog.vue:113`：文案缩短为「模型已更新 / 已恢复宿主默认」（按 reset 分支），加 2s 时长。
  6. `SettingsDialog.vue:226`：保留短 toast「配置已创建」（2s）；配置列表可折叠滚动，除非能定位到新行，不直删。
  7. `GroupWorkspacePage.vue:668`：P0-2 已删 description，本项确认最终态为「短标题 + 2s」。
  8. `GroupWorkspacePage.vue:677`（恢复团队）与 `:700`（归档团队）：保留 2s 短 toast（归档还会跨视图跳转，恢复列表可能滚出视口）。
  9. 错误 toast 全部不动。
- **前置依赖：** B1 合并（`:668` 依赖 P0-2；`:405` 由 P0-3 完成）。
- **验收：** 确认弹窗先关、结果状态在操作视口内即时翻转；短 toast 不遮挡输入区；无重复长文案（实机清单 5/6）。
- **回滚/风险：** 逐处恢复原 duration/文案；风险是列表滚动导致结果不可见（不直删的理由），2s 是否读得清需实机。
- **是否需实机验证：** 是。
- **并行/串行：** G2。
- **工作量估计：** S（0.5d）。

### P1-3 侧栏常驻教学句

- **目标：** 团队关系区无常驻教学句，行/菜单入口不退化。
- **涉及文件与行号：** `web/src/features/panel-agent/PanelAgentSidebar.vue:115-117`（位于 `CollapsibleContent` 内）。
- **具体改动步骤：** 删除 `:115-117` 整段 `<p>`；不新增说明弹层、不把句子收进 tooltip（报告允许二选一，默认取删除）。
- **前置依赖：** 无。
- **验收：** 团队关系区仍能通过行/菜单进入团队；无常驻教学句。
- **回滚/风险：** 恢复 `<p>` 即可；风险是首次使用理解成本（报告 P4 级，接受）。
- **是否需实机验证：** 否（静态文案删除；首用理解随 P2-2 的实机一起看）。
- **并行/串行：** G2。
- **工作量估计：** S（0.5h）。

### P1-4 Modal 目录错误改内联 + 过期请求防护

- **目标：** 目录失败错误显示在选择器旁且持续可见；关闭/换人后旧请求静默。
- **涉及文件与行号：**
  - `web/src/features/groups/MemberModelDialog.vue:56`（`toast.error('宿主模型目录不可用')`，改内联）、`:79`（`toast.error('读取模型目录失败')`，改内联）、`:85-98`（watcher，仅在 `isOpen && member` 时请求）、`:125`（`Dialog` 可关闭但无取消/过期校验）、`:133-139`（可复用的加载区/选择器内联区）。
- **具体改动步骤：**
  1. 新增 `catalogError = ref<string | null>(null)`；`loadCatalog()` 开头清空 `catalogError`，失败分支写入 `catalogError`，成功加载清空。
  2. 在模型选择器位置（`:133-139` 区域）新增 `Alert` 内联展示 `catalogError`，附「重试」按钮（复用 `PanelAgentSetup.vue:111-121` 的 `Alert` + `重试` 样式）。
  3. 竞态防护：`loadCatalog` 递增请求序号（`const requestSeq = ++loadSeq;`），响应/异常返回后比对 `requestSeq === loadSeq && open.value && props.member.id === 请求时的 memberId`，不满足则静默丢弃；`Dialog` 关闭（`open` 变 false）后清空 `catalogError` 与加载态，旧请求不回写。
  4. 不要新增 toast 替代原错误提示。
- **前置依赖：** 无（文件内 C10 已在 B2 改，本项不依赖它，但合并顺序 B2 在前可避免冲突）。
- **验收：** 目录失败时错误显示在选择器旁且持续可见；切换成员/关闭后旧请求不覆盖新状态（实机清单 8）。
- **回滚/风险：** 内联错误与新 state 回退即删；竞态处理需仔细（错误反馈正确性改动，C2）。
- **是否需实机验证：** 是。
- **并行/串行：** G3（与 P1-1a 并行开发）。
- **工作量估计：** M（1d）。

### P1-5 归档确认补恢复路径

- **目标：** 归档弹窗直接给出恢复路径。
- **涉及文件与行号：** `web/src/pages/GroupWorkspacePage.vue:1152`（确认弹窗 description）。
- **具体改动步骤：** `:1152` 改为「归档后团队不再接收消息或启动任务。可在 设置 → 归档团队 中恢复。」保留确认弹窗本身，不新增恢复确认弹窗，不做两种恢复文案并存。
- **前置依赖：** 无。
- **验收：** 归档弹窗能直接看到恢复路径；恢复入口无需猜测。
- **回滚/风险：** 恢复原文案即可；纯文案，无风险。
- **是否需实机验证：** 否。
- **并行/串行：** G1。
- **工作量估计：** S（0.5h）。

### P2-1 任务面板文案与 `tasks_set`

- **目标：** 空态与页脚不再暴露内部工具名。
- **涉及文件与行号：** `web/src/features/groups/TasksPanel.vue:41-46`（空态 `PanelState` description）、`:71-74`（页脚教学句）。
- **具体改动步骤：**
  1. `:45` description 改为「成员更新任务后会显示在这里」（去掉 `tasks_set` 工具名与「不阻塞流程」解释）。
  2. 删 `:71-74` 页脚教学句整段 `<p>`。任务状态徽章与列表保留。
- **前置依赖：** 无。
- **验收：** 空态不含 `tasks_set`；有任务时页脚不再重复教学；任务状态仍可读。
- **回滚/风险：** 恢复原文案；纯文案。
- **是否需实机验证：** 否。
- **并行/串行：** G1。
- **工作量估计：** S（0.5h）。

### P2-2 空团队侧栏句

- **目标：** 空团队时只有主页一处完整说明。
- **涉及文件与行号：** `web/src/app/layouts/GroupSidebar.vue:517-522`（「还没有团队。先在 CLI 中创建团队。」）、`web/src/features/groups/TeamHome.vue:269-280`（主页空态，保留）。
- **具体改动步骤：** 删除 `GroupSidebar.vue:517-522` 整段（侧栏句）；或仅在首页抑制侧栏句——默认取删除，主页空态保留完整说明与「会自动显示在这里」的解释。
- **前置依赖：** 无。
- **验收：** 空团队时只有一处完整说明；窄屏仍能理解下一步（实机清单 3）。
- **回滚/风险：** 恢复侧栏句；风险是窄屏/侧栏折叠时主页空态可读性（需实机确认）。
- **是否需实机验证：** 是。
- **并行/串行：** G1。
- **工作量估计：** S（0.5h）。

### P2-3 API Badge

- **目标：** 待产品确认后决定删除或区分标签。
- **涉及文件与行号：** `web/src/features/panel-agent/PanelAgentModelSelector.vue:156`、`:223`（`<Badge variant="outline">API</Badge>` 两处）。
- **具体改动步骤：** 先向产品确认「是否所有宿主都属 API」：若确认 → 删两处 Badge；若存在 API/CLI 类别差异 → 按 `host` 字段改有区分度的标签。**确认前不动代码。**
- **前置依赖：** 产品确认（B4 前置动作）。
- **验收：** 确认后按结论执行；删除后选择器无重复无意义 Badge。
- **回滚/风险：** 恢复 Badge 即可。
- **是否需实机验证：** 否。
- **并行/串行：** B4 单独。
- **工作量估计：** S（0.5h，不含确认等待）。

### P2-4 运行数量与同步时间

- **目标：** 先核对口径，再决定文案区分与同步时间保留方案。
- **涉及文件与行号：** `web/src/pages/GroupWorkspacePage.vue:880-885`（header「N 个运行中」，过滤 current endpoints）、`:981-987`（聊天页脚同步时间）；`web/src/features/groups/CollaborationPanel.vue:85-87`（「N 个运行中回合」summary 按 group 计）；`web/src/app/layouts/GroupSidebar.vue:525`、`:537-556`（侧栏底部同步时间）。
- **具体改动步骤：**
  1. P2-4a（纯确认，B4 前置）：与主 Agent/产品核对两个「运行中」数字的定义与目标口径——header 是「当前会话运行中 endpoint 数」，概览是「团队级运行中回合数（排除 private/panel）」。产出结论写入本计划修订版或任务笔记。
  2. P2-4b：按结论在文案上区分（如 header 保留「N 个运行中」、概览改为「N 个运行中回合」已自带区分度，确认是否需要再改）；同步时间保留一处——若删 footer，必须保证侧栏折叠/窄屏仍能看到最后同步时间（实机清单 9），否则保留 footer 兜底。
- **前置依赖：** P2-4b 依赖 P2-4a 口径结论。
- **验收：** 两个运行数字文案可区分、不误导；同步时间至少一处可见。
- **回滚/风险：** 文案回退；删 footer 前必须通过实机清单 9。
- **是否需实机验证：** P2-4b 需实机（若删 footer）。
- **并行/串行：** B4 单独（P2-4a 可与所有批次并行推进）。
- **工作量估计：** P2-4a S（2–4h，含沟通）；P2-4b S（0.5–1h）。

### P2-5 PanelAgentSetup 说明密度

- **目标：** 创建/编辑页说明压到必要量，保留权限关键信息。
- **涉及文件与行号：** `web/src/features/panel-agent/PanelAgentSetup.vue:75-81`（principles 数组）、`:94-95`（「LOCAL PANEL AGENT / 全局单例」）、`:100-103`（介绍段）、`:200-220`（「运行边界」卡片）。
- **具体改动步骤：**
  1. 「运行边界」5 条折叠为 `Collapsible`（默认收起），或只保留权限关键 1–2 条（至少保留「只有用户确认后才能接管团队」）；其他条目移入折叠区。
  2. `:100-103` 介绍压成一句（如「一个 Agent 同时承担全局私人会话与获准后的团队主控。」）。
  3. 不删权限关键信息；`LOCAL PANEL AGENT`/「全局单例」保留或并入一句。
- **前置依赖：** 无。
- **验收：** 页面默认信息密度下降；权限关键条目仍可见（或一展开即见）。
- **回滚/风险：** 恢复原文案；低频页面，最后做。
- **是否需实机验证：** 否。
- **并行/串行：** B4 单独。
- **工作量估计：** S（1–2h）。

### P2-6 核实停止描述重复

- **目标：** 同一确认点不问两遍。
- **涉及文件与行号：** `web/src/features/panel-agent/PanelAgentPanel.vue:396-399`。
- **具体改动步骤：** `:397-398` 的 description 改为「确认后标记为已停止，团队恢复调度。」（去掉「请先确认对应宿主进程已经实际停止」）；`askConfirm` 的 `confirmText` 与 destructive 属性不变。
- **前置依赖：** 无（与 P0-3 的 `:405` 同文件不同行，B1 内先改 P0-3 再改本项，注意行号偏移）。
- **验收：** 弹窗标题问一次、描述只讲后果。
- **回滚/风险：** 恢复原文案；纯文案。
- **是否需实机验证：** 否。
- **并行/串行：** G1。
- **工作量估计：** S（0.5h）。

### C10 死代码 toast

- **目标：** 不可达的「请先选择模型」分支改为直接 return。
- **涉及文件与行号：** `web/src/features/groups/MemberModelDialog.vue:104-106`（`toast.error('请先选择模型')`）；`MemberModelDialog.vue:142`（保存按钮 `!form.model` disabled，当前分支不可达的守卫）。
- **具体改动步骤：** `:104-106` 改为 `if (!reset && !form.model) return;`；保留按钮 disabled 与校验；不要声称「绝对不可达」。
- **前置依赖：** 无（与 P1-4 同文件，B2 完成）。
- **验收：** 空模型点保存无 toast、无请求；disabled 状态不变。
- **回滚/风险：** 恢复原分支；无风险。
- **是否需实机验证：** 否。
- **并行/串行：** G2。
- **工作量估计：** S（0.5h）。

### C17 风险记录（不新增提示）

- **目标：** 本轮不改，记录后续处置方案。
- **涉及文件与行号：** `web/src/stores/team-directives.ts:46-62`（新请求失败时保留旧 receipt）、`web/src/features/messages/TeamDirectiveComposer.vue:19`、`:33-35`（旧 receipt 展示）。
- **本轮动作：** 无代码改动；在后续批次（不在本计划批次内）可在新 attempt 开始时清掉旧 receipt 或标为「上一条」。本轮不加 toast、不改发送交互。
- **前置依赖：** 无。
- **验收：** 本轮不产生该文件 diff。
- **是否需实机验证：** 否。
- **并行/串行：** 无。
- **工作量估计：** S（0，仅记录）。
