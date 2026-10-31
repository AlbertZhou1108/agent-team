# 前端设计收敛:阶段 A 规则台账

日期：2026-10-31。基线：提交 7af3877（工作区干净）。依据：[收敛计划](frontend-design-convergence-plan.md) 阶段 A；设计规则见 [DESIGN.md](../DESIGN.md)。

状态：**阶段 A-D 全部完成**（2026-10-31）。基线截图存于 `work/dev-baseline/`（git 忽略），01-09 为收敛前基线，10-14 为收敛后巡检。执行结果见 §5（A/B/C）与 §6（D）。

## 0. 检查基线与方法

- 自动化：`npm run typecheck` 通过；`npm run test:web` 27 个文件 132 个用例全部通过（2026-10-31，提交 7af3877）。
- 检索方式：三路只读检索（颜色与表面、排版尺寸形状、动效滚动反馈），覆盖 `web/src` 全部 `.vue/.ts/.css`，排除 `*.test.ts`。
- 总体判断：主题收敛度已很高 —— 业务页面（features/app/pages/ai-elements）**零**命名调色板类、**零** `dark:` 覆盖、**零** backdrop-blur、**零**自定义 box-shadow；globals.css 非 token 区已完全消费语义变量。残余问题集中在 8 个点（见 §2 小结）。

## 1. 事实标准（已实质形成，立为规则即可）

| 规则 | 现状证据 | 目标归属 |
| --- | --- | --- |
| 正文 16px / leading 1.6 | globals.css:111-116 | 共享排版基线 |
| UI 密度两档 text-sm(104 处)/text-xs(154 处) | 全库分布 | 共享排版刻度 |
| 页面标题 text-2xl font-semibold（5 处 h1） | TeamHome:219、SettingsDialog:513、PanelAgentSetup:98、NotFoundPage:15、main.ts:22 | 共享排版层级 |
| 控件圆角 rounded-md(39)/容器 rounded-lg(18)/胶囊 rounded-full(17) | 全库分布 | 共享形状规则 |
| 字重：标题 semibold、标签 medium、正文不设 weight，font-bold 为 0 | 全库分布 | 共享排版规则 |
| 页面容器 `min(100%, Npx)` 模式（960/1040/1080px） | globals.css:176/348/186 | 共享布局规则 |
| 弹层 z-50、局内浮动 z-10 两档 | components/ui 浮层组件 | 共享层级规则 |
| 确认交互统一 ConfirmDialog（无 window.confirm/AlertDialog） | components/panel/ConfirmDialog.vue，4 处消费 | 共享反馈组件 |
| 阴影只用 Tailwind 标准等级，无自定义阴影色 | 业务区仅 SettingsDialog:579,769（shadow-xs） | 共享表面规则 |
| 流式跟底刻意不平滑（仅手动回底按钮 smooth） | ConversationScroller.vue:79/161、ReasoningScroller.vue:23 | 动效用途规则 |

## 2. 规则台账（候选问题，按目标批次分组）

每条含：来源位置 / 场景 / 冲突证据 / 建议处理（保留｜复用现有组件｜迁入共享层｜删除冗余｜暂缓）。

### B1 颜色与主题

| 编号 | 位置 | 场景与证据 | 建议处理 |
| --- | --- | --- | --- |
| C1 | components/ui/button/index.ts:14、badge/index.ts:16 | destructive 变体写死 `text-white`；token `--destructive-foreground` 已存在 | 迁入：改为 `text-destructive-foreground`，机械替换、语义等价 |
| C2 | components/ui/slider/Slider.vue:40 | 滑块拇指写死 `bg-white`，深色主题下是纯白亮点 | 迁入：改为 `bg-background` |
| C3 | components/ai-elements/MessageAttachments.vue:161-192 | 图片灯箱浮层 `bg-black/40`、`text-white/60~85`、`border-white/30`（约 9 行）——覆盖在图片上的媒体浮层，图片不受主题影响 | 保留；若 D2 玻璃材质需要，再议 `--overlay` token |
| C4 | app/layouts/TeamMenu.vue:44-48 | 团队标签五色板（用户可选并持久化的数据级颜色），消费点 SidebarEntry:11、TasksPanel:53 | 保留；可抽共享常量避免散落 |
| C5 | features/messages/identity.ts:12；消费点 AgentMessage:79/107、RunStatusCard:90/139 | 成员名哈希 hsl 身份色（图表系列色同类）。AgentMessage:79 的 `color: 'white'` 与 46% 明度身份色耦合 | 保留机制；`color:'white'` 在 D 系列评估身份色前景 token，暂缓 |
| C6 | app/layouts/TeamMenu.vue:73 | 选中标签描边 `color-mix(…, black 45%)` 依赖 black | 暂缓；收敛时换 `var(--foreground)` 派生或选中态 token |
| C7 | components/ui/bubble/index.ts:17 | tinted 变体 `oklch(from var(--primary)…)`，已从 token 派生 | 保留 |

### B2 表面与形状

| 编号 | 位置 | 场景与证据 | 建议处理 |
| --- | --- | --- | --- |
| S1 | globals.css:727/745/775 | run-card 系裸 px 圆角 10/4/6px，绕开 --radius 链（4px≈rounded-sm、6px/10px 无对应档） | 迁入：并入 radius 档位 |
| S2 | globals.css:664/806/137/1325 | `border-radius: 999px/9999px` 胶囊写法 ×4，与模板里 rounded-full 并行 | 迁入：统一为一种写法 |
| S3 | components/ui/input-group/index.ts:12/39/41 | `rounded-[calc(var(--radius)-5px)]` 硬算术，未复用 --radius-sm | 暂缓（shadcn 上游组件，改动需按 AGENTS.md 约定最小化） |
| S4 | globals.css:616 | `.jump-to-bottom` 无 z-index；同容器消息操作簇为 z-10，可能倒挡遮挡 | 迁入：随层级规则修复；需浏览器确认是否实际发生 |
| S5 | globals.css:490/1203/1089/1071 | z-index 中段 20/25/30/40 为手工递增裸数字链，无语义；与 z-50 浮层体系之间无位可插 | 迁入：B2 记录层级归属，暂不引入新 token，先文档化 |
| S6 | 全库 | backdrop-blur/blur-\* 0 处；`dark:` 17 行全部在 components/ui 组件默认样式中 | 保留：与 DESIGN.md"材质尚无独立选项、现有界面为实色表面"的现状描述一致 |

### B3 排版与尺度

| 编号 | 位置 | 场景与证据 | 建议处理 |
| --- | --- | --- | --- |
| T1 | features/telemetry/ 全区 | `text-[11px]`×23、`text-[10px]`×3 微标签自成事实档却用任意值，且 10/11px 两档并存 | 迁入：并入命名刻度（xs 之下统一一档） |
| T2 | 5 处页面 h1 | 页面标题数值抄 markdown h1（text-2xl font-semibold）但缺 tracking-tight，无独立页面标题规则 | 迁入：B3 立页面标题层级 |
| T3 | ConversationWorkspace.vue:29、InspectorPanel.vue:132/145 vs 26 处 h3/h4 | 二级页头滑到 text-base；小节标题在 text-xs 与 text-sm 间摇摆（telemetry 15、SettingsDialog 8、CollaborationPanel 4） | 迁入：立小节标题档位 |
| T4 | ai-elements/BubbleContent.vue:22 vs AgentMessage.vue:164 | 同为聊天气泡正文，行距双轨 leading-relaxed vs leading-7（后者与 markdown 基线重复声明） | 迁入：统一为 leading-7 |
| T5 | ConversationMessage.vue:44 vs globals.css:431 | 阅读宽度双轨：用户气泡 `min(78%,760px)` vs 助手正文 820px | 暂缓：需先判断差异是否有业务依据 |
| T6 | 各 Dialog 文件 | 弹窗宽度 md/lg/xl/2xl/3xl 六档并存，按文件各自挑选 | 迁入：立弹窗档位规则（小-md/中-lg/大-2xl 方向） |
| T7 | CollaborationPanel.vue:79/104/122/139、SettingsDialog.vue:747 | `text-xs font-semibold tracking-wide` 小节标签套路 ×5 | 迁入：随 T3 一起立规则 |

### B4 当前动效

| 编号 | 位置 | 场景与证据 | 建议处理 |
| --- | --- | --- | --- |
| M1 | globals.css:1337-1339；ConversationScroller.vue:78；ExpandableText.vue:54 | 减少动效判断三套路径：全局 CSS 通配（管不到 JS smooth 滚动与 WAAPI）、两处独立 matchMedia（行为不同：降级滚动 vs 跳过动画），无共享工具 | 迁入：B4 收口为统一判断（D1 前置） |
| M2 | components/ui/message-scroller/（未接线引擎） | MessageScrollerButton 默认 `behavior:'smooth'` 且无 reduced-motion 判断；目前无消费者 | 暂缓：接线前必须补判断，台账记录 |
| M3 | components/ui 弹层类（dialog/popover/select/dropdown/tooltip） | `animate-in/fade-in-0/zoom-in-95/slide-in-from-*` 与 TraceCollapsibleContent:17 `animate-collapsible-up/down`、TraceTitle:13 `motion-reduce:shimmer-none` 无 keyframes 来源：package.json 无 tailwindcss-animate/tw-animate-css，globals.css 无对应 keyframes —— 疑似无效类 | **待浏览器验证**：确认弹层是否实际无动画后，B4 决定补依赖或清理类名 |
| M4 | globals.css:1321-1335；animate-spin/pulse 分布 | 全库唯一 @keyframes 为 loading-dot；消息流内 LoadingDots×2、run-dot pulse、LoaderCircle spin，无骨架屏 | 保留：现状健康，随 M1 收口时归档 |

### B5 状态与反馈

| 编号 | 位置 | 场景与证据 | 建议处理 |
| --- | --- | --- | --- |
| F1 | toast 32 处/9 文件 | 成败范式不统一：SettingsDialog 成败都 toast（362/364/446/460），PanelAgentPanel 成 toast 败内联（323/357 vs actionError）；SettingsDialog 内部导入失败内联（183）而删除失败弹 toast（204） | 迁入：立"何时 toast、何时内联"规则后逐处归位 |
| F2 | CollaborationPanel.vue:53-55 vs GroupWorkspacePage.vue:694-696 | "恢复团队"双实现，toast 文案几乎相同 | 删除冗余：收敛为一处 |
| F3 | MemberModelDialog.vue:105 vs InteractionCard.vue:92/163 | 同类校验提示一处 toast、一处内联 inputError | 迁入：随 F1 规则归位 |
| F4 | globals.css:963-976 | `.empty-state` class 在 src 内无消费者；实际空态全部走 shadcn Empty/PanelState | 删除冗余（确认无动态拼接类名后） |
| F5 | PanelAgentSetup.vue:112/165、PanelAgentPanel.vue:543（.error-banner）vs CollaborationPanel.vue:72（Alert destructive） | 就近错误两种呈现并存 | 迁入：立就近错误规则后归位 |
| F6 | messages/interaction-notification.ts:5-16；globals.css:1342-1351 | 互动通知 duration:Infinity + 自定义 toast 布局，与 DESIGN.md 通知层级一致 | 保留 |

## 3. 分批整改建议（映射收敛计划 §4）

- **B1（颜色）**：仅 C1、C2 两个机械替换，风险低，可最先做；C3-C7 保留或暂缓。
- **B2（表面）**：S1/S2 机械收敛；S4 需浏览器确认后修；S5 文档化；S3 暂缓。
- **B3（排版）**：T1/T4 机械；T2/T3/T6/T7 需先立层级规则再迁移，是本阶段工作量主体；T5 暂缓待判断。
- **B4（动效）**：先做 M3 验证（决定弹层动画是否真的缺失），再 M1 收口；M2/M5 暂缓。
- **B5（反馈）**：F2/F4 直接清理；F1/F3/F5 需先立规则。

## 4. 已知限制与待办

1. **浏览器基线未录制**：代表性页面（团队首页、团队工作区、Panel Agent、检查/遥测、设置）的桌面与窄屏截图、浅深主题、侧栏状态、关键交互待补；阶段 A 验收前完成。
2. 静态检索无法确认运行时表现：M3（弹层动画）、S4（jump-to-bottom 遮挡）需浏览器验证后才能定性。
3. 检索未覆盖 `<style>` 之外的运行时样式计算；未发现相关迹象，如批次中发现新证据再补录。
4. 本台账为过程证据，不构成视觉规范；整改以 DESIGN.md 与收敛计划为准。

## 5. 阶段 B/C 执行结果与收敛验收记录

日期：2026-10-31。基线 7af3877 → 收敛后 HEAD。自动化：typecheck 通过、27 文件 132 测试通过、`npm run build` 通过（chunk 体积警告为既有情况）。浏览器证据：截图 10-12（首页/工作区右栏收起/详情页）+ CSSOM 扫描 + 计算样式抽查；录制后偏好已恢复跟随系统。

### 收敛前定案（阶段 A 浏览器验证结论）

- **M3（缺陷确认）**：编译后 CSSOM 中 `animate-in`/`fade-in-0`/`zoom-in-95`/`slide-in-from-*`/`collapsible-*`/`shimmer-none` 0 条规则，弹层动画类全部无效 —— 缺少 tw-animate-css，collapsible/shimmer keyframes 从未定义。
- **S4（风险确认）**：`.jump-to-bottom` 为 `z-index:auto`，与消息操作簇 z-10 存在倒挂风险。

### 批次提交与条目处置

| 批次 | 提交 | 处置条目 |
| --- | --- | --- |
| B1 | 884364e | C1（button/badge `text-white`→`text-destructive-foreground`）、C2（Slider `bg-white`→`bg-background`） |
| B2 | 89da2f6 | S1（run-card 裸圆角 10/4/6px→radius 链）、S2（999px 胶囊统一 9999px）、S4（回底按钮 z-20，浏览器复验可见且生效）、S5（z-index 层级刻度注释） |
| B3 | 62cec47 | T1（26 处 text-[11px]/[10px] → 命名档 `text-2xs` 0.6875rem，CSSOM 验证生成、详情页 10 节点渲染 11px）、T2（5 处页面 h1 加 tracking-tight）、T4（气泡正文统一 leading-7） |
| B4 | 952ffad | M3（新增 tw-animate-css 依赖 + collapsible keyframes，弹窗动画复验 `enter/0.2s`）、M1（共享 `prefersReducedMotion()`，ConversationScroller/ExpandableText 收口）、shimmer 死类移除 |
| B5 | 12efbc4 | F3（模型对话框校验 toast→禁用按钮原因提示）、F4（`.empty-state` 死 CSS 删除）、F5（PanelAgentSetup 裸错误段→Alert destructive） |

### 判定保留或暂缓（有据）

| 条目 | 判定 |
| --- | --- |
| C3 灯箱黑底浮层 / C4 团队标签色板 / C5 身份哈希色 / C7 bubble 派生色 | 保留：数据驱动色或媒体浮层，非表面样式；C5 的 `color:'white'` 留待 D 系列身份色前景一并评估 |
| C6 TeamMenu color-mix black | 暂缓：低优先，收敛时换 foreground 派生 |
| S3 input-group 半径硬算术 | 暂缓：shadcn 上游组件，按 AGENTS.md 最小改动原则不批量覆盖 |
| T3 telemetry h3(sm)/h4(xs) | 判定为**有意的两级层级，非冲突**（h3=区块标题、h4=子区标题），保留并立为规则 |
| T5 阅读宽度双轨（用户气泡 760 vs 正文 820） | 暂缓：气泡与长文正文职责不同，待 D3 阅读设置统一处理 |
| T6 弹窗宽度 | 判定已连贯（确认/提示 md、表单 lg、内容 2xl、媒体 3xl），立为规则不改码 |
| F1 toast/内联分工、F2 恢复团队双入口 | 判定为**符合规则或两个入口**而非重复反馈：字段域校验内联（导入失败在对话框内内联）、操作结果 toast；两处恢复团队是不同刷新域的独立入口。规则记录于 DESIGN.md |
| M2 message-scroller 未接线引擎 | 暂缓：接线前必须接入共享 prefersReducedMotion |
| M5 MessageScrollerButton 自定义缓动 | 暂缓：随 M2 |

### 收敛完成门槛核对（计划 §5）

- 重复或冲突规则已处理，暂缓项均有原因、影响与后续入口 ✓
- 颜色/表面/形状/排版/尺度/动效/反馈归属明确；迁移范围内无功能相同的双重应用路径 ✓（B4 收口后 JS 侧减少动效判断仅剩共享工具一条路径；message-scroller 未接线，已在台账挂起）
- 主题格式、导入校验、旧偏好、首帧快照与回落行为兼容 ✓（未触及 theme/ 与 preferences 持久化代码；resolve/validate/preferences 测试全绿）
- 默认外观无未说明的大幅变化。**可见差异清单**：深色下滑块拇指由纯白改为背景色（token 语义）；run-card 圆角 10px→8px；3 处 10px 微标签升为 11px；页面 h1 增加字距收紧；聊天气泡正文行距 1.625→1.75；弹窗/浮层恢复入场出场动画；PanelAgentSetup 操作错误由裸文本变为 Alert 样式
- 会话草稿、选中项、展开状态、历史位置、流式追加、输入与恢复入口 ✓（输入区可正常输入；右栏收起/展开正常；样式迁移未触及组件身份与数据流；流式追加无法在无真实模型请求下触发，以组件身份未变 + 既有 ConversationWorkspace/MessageFeed 测试为据，记为环境限制）

### 剩余问题（进入 D 系列前的已知项）

1. 流式追加的动效与跟底行为未做真实链路复验（禁止触发真实模型请求）。
2. M2/M5 随 message-scroller 接线处理。
3. C5 身份色前景、T5 阅读宽度随 D2/D3 处理。

## 6. 阶段 D 执行记录(D1-D4)与 D5 评估结论

日期：2026-10-31。自动化:typecheck 通过、29 文件 139 测试通过(含 motion/presets 新增单测)。

| 批次 | 提交 | 交付与验证 |
| --- | --- | --- |
| D1 统一动效选项 | 0d4a5f3 | 五选项(跟随系统/减少/简洁/柔和/灵动);解析为 `<html data-motion>`,显式选择优先、仅跟随系统响应系统偏好;CSS kill-switch 与 JS 判断同源;风格节奏经 `--motion-pace` 作用于共享动画。实测:切换/持久化/恢复、减少态 transition 1e-05s、未知值回落 |
| D2 玻璃材质 | 2157bde | 默认实色 + 一种磨砂玻璃;只映射导航/上下文/会话操作区角色,阅读面与浮层保持实色;配色派生(color-mix)+ 静态环境光斑供模糊取样;`@supports` 与 `prefers-reduced-transparency` 双回落实色。实测:blur 计算值、持久化、切回 |
| D3 密度与阅读 | 24714ba | 密度三档只调共享间距(data-density);阅读四参数(字号/行距/宽度/代码字号)写为 CSS 变量由 markdown 与正文宽度消费,行距按字号比例缩放(实测 19px×1.75);阅读独立于外观其他维度。实测:compact 52px/14px、持久化、恢复 |
| D4 组合预设与统一预览 | 05196a8 | 外观五维度改为草稿式统一编辑:实时预览真实界面(预览与提交走同一 applier,所见即所得),「应用外观」才落盘,「取消」/关闭即还原;「主题点击即保存」显式迁移完成;自定义组合徽标;命名预设(本地存储+校验),主题失效按维度回落并如实显示;恢复默认不触及阅读与业务配置。实测:预览不落盘、取消恢复、保存/应用/删除预设、刷新持久化 |

环境说明:预览采用"真实界面 + 外观样例卡"组合(2026-10-31 修订):初版仅依赖真实界面,但用户反馈材质/密度/动效在其目标表面不在设置页视野内时无法感知;随后在外观标签页顶部加入微缩会话样例卡(AppearanceSample,与真实表面消费同一份 data-material/data-density 规则与阅读变量,含动效重播演示),并让动效风格真正接入弹层动画节奏。主题包快照在应用时写入,保持首帧无闪回。

### D5 评估结论:暂缓引入纸感、液态折射与新动效风格

依据 D1/D2 验证结果评估(计划 §6 D5 为决策门槛):

1. **模型表达能力充足**:统一外观模型(明暗×主题×材质×动效×密度)经四个批次实测,所有共享表面角色(导航/上下文/会话操作区/阅读面/浮层)均可由 data-* + 共享 CSS 表达,未出现需要页面分支绕过模型的情况 —— 计划关注的"先修正共享职责"前提已满足,无阻塞项。
2. **纸感材质:暂缓**。机制上可作为第三个 `data-material` 值增量加入(环境纹理层 + 实色表面,成本低);但用户此前已明确搁置纸感方向(见记忆与历史决策),且当前无需求信号。保留为设计空间,待明确需求后按 D2 模式增量交付。
3. **液态折射:暂缓**。需要 SVG 滤镜/背景畸变,浏览器性能与可读性风险未实测;DESIGN.md 已规定"高级效果的浏览器表现与性能需实测后再确定承诺范围"。在玻璃材质未暴露表达不足前不投入。
4. **其他动效风格:不新增**。五档风格 + 节奏系数已覆盖用途空间;B4 收口后未见语义缺口。
5. **再引入的路径**:均按既有模式增量进行 —— 新材质 = 新 `data-material` 值 + 角色映射 + 回落;新动效 = 新风格档 + `--motion-pace`/参数表;无需改动页面代码。

