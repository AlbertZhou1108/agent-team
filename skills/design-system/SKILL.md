---
name: design-system
description: AgentTeam 前端设计体系操作手册：写或改 web/src 的页面与组件时使用，提供全贴边壳层、圆角刻度、颜色、表面、动效的语义档位对照与常见迁移模式，避免手写样式绕过设计体系。
---

# AgentTeam 设计体系速用手册

设计基线在 `docs/DESIGN.md`（Quiet Instrument 气质、方案 A 全贴边壳层与业务不变式），契约在 `web/src/theme/component-contract.ts`（约 70 个 `--component-*` 变量），材质规格在 `web/src/theme/materials.ts`（材质 × 表面角色）。本手册只回答“写代码时要 X 用 Y”。

## 自查（每次改完 web/src 都跑）

```bash
node scripts/check-design.mjs   # 全树约 0.3s，违例明细带文件行号
node scripts/check-layering.mjs # 纯 Web 边界阻断检查
npm run check:web               # 完整前端静态检查（check-design + layering + vue-tsc + eslint）
```

## 场景 → 必用组件 / 原语速查

| 场景 | 必用组件 / 原语 | 禁止写法 |
| --- | --- | --- |
| 容器级表面/边框/弱提示 | `<Surface role="...">` / `<Card size="sm\|md\|lg">` / `<NoteBlock size="sm\|md\|lg">` | 卡片内再套 `<Card>` / 传旧别名 `compact`/`default` |
| 面板带边框分区容器 | `<SectionBlock size="sm\|md\|lg" layout="stack\|inline">`（含 `@container`） | 业务目录手写 `rounded-(--component-card-radius) border` |
| KPI / 指标卡片 | `<MetricCard size="sm\|md\|lg">`（可选 `:progress`，统一 `22px` 主数值基线） | 业务目录手写边框指标块 |
| 标签页 / 分段切换 | `<Tabs>` + `<TabsList variant="pill"\|"underline" size="xs\|sm\|md\|lg">` + `<TabsTrigger>` / `<ToggleGroup>` | 业务目录手写 `role="tablist"` 或 `h-6.5`/`text-2xs` 覆写 |
| 通用折叠 / 首页状态条展开 | `<Disclosure>` / `<DisclosureFooter>` / `<DisclosureChevron>` / `SidebarEntry` + `<CollapseReveal>` | 在 `<CollapseReveal>` 直接子节点写 `v-if`（会截断收起动画） |
| 水平或行内垂直分割线 | `<Separator size="full"\|"inline">` | `class="h-3.5!"` 等 Tailwind `!` 强制覆写高度 |
| 显式微交互过渡 | `transition-colors` 或 `transition-(transform\|opacity) duration-(--component-feedback-duration)` | `transition-all` 或不带 `duration-(--component-*)` 的显式过渡 |

## 全贴边壳层与尺寸档位

- **方案 A 全贴边壳层**：`--component-sidebar-inset: 0px`、`--component-panel-gap: 0px`（四套预设统一）。`nav-panel` 与 `context-panel` 贴边零外圆角零外投影，以 `1px` 发丝分割线与三阶明度（`L0` / `L0b` / `L1`）分隔；`overlay`（弹窗/下拉/回底按钮）保留 `--component-panel-radius` 与独立浮层层次。
- **控件族**（`Button` / `Input` / `InputGroup` / `SelectTrigger` / `Toggle` / `ToggleGroup` / `Tabs` / `Avatar`）：统一 **`xs | sm | md | lg`**（默认 `md`；`Badge` 支持 **`xs | sm | md`**；`Button` 图标用 **`icon-xs | icon-sm | icon-md | icon-lg`**），高度消费 `--component-control-*`。
- **容器族**（`Card` / `SectionBlock` / `MetricCard` / `Item` / `PanelState` / `Empty` / `NoteBlock`）：统一 **`sm | md | lg`**。
- **语义尺寸例外**：`Separator` 保持 `size="full" | "inline"`。

## 圆角刻度（随材质取值，组件按语义取档）

| 档位 | 变量 | 语义 | 经典 | 玻璃 | 纸 | 活力 |
| --- | --- | --- | --- | --- | --- | --- |
| panel | `--component-panel-radius` | 浮层 / 独立内嵌卡片容器 | 8 | 8 | 6 | 22 |
| card | `--component-card-radius` | 消息卡 / 空态 / 投放区 | 12 | 12 | 8 | 16 |
| control | `--component-control-radius` | 按钮 / 输入 / 预设卡 / KPI 格 | 6 | 8 | 4 | 14 |
| chip | `--component-chip-radius` | 徽章 / 团队行 / 菜单项 / 小件 | 6 | 6 | 4 | 10 |

写法：`rounded-(--component-control-radius)`。禁止 `rounded-sm/md/lg/xl/2xl/3xl` 字面量；`rounded-full`、`rounded-none`、`rounded-xs` 例外。

## 颜色与数据色板

- 界面样式只消费语义 token：`--background`（左右分栏）/ `--card`（主工作画布）/ `--secondary` & `--muted` & `--popover`（输入/面内卡/浮层）/ `--accent`（悬停与高亮）/ `--foreground` / `--muted-foreground` / `--border` / `--input` / `--ring` 与四态色（`--success`/`--warning`/`--info`/`--destructive`）。
- 派生用 `color-mix(in oklch, var(--info) 16%, transparent)`；禁止 Tailwind 调色板类（`text-zinc-500`）与裸 `black/white`。
- 图片浮层控件用 `--component-image-scrim-fg` / `--component-image-scrim-bg`。
- **数据色板豁免区**：`shared/team-colors.ts`、`features/messages/identity.ts`（采用低眩光 6 色 Tinted Identity Badges：`identityColor` 作左标/连线，`identityTintBg` + `identityTintFg` 作柔底徽标）。

## 表面与容器

- 5 个已注册表面角色：`nav-panel` / `context-panel` / `action` / `input` / `overlay`（经 `<Surface role="...">` 或 `data-surface="..."` 声明）。
- 主工作面容器使用 `ConversationFrame`（`data-component='content-surface'`，无外框圆角）；面内独立卡片用 `Card`，弱提示块用 `NoteBlock`。
- 同类列表（团队列表、成员开销排行、笔记列表）使用分割线行 + 左侧 `2px` 选中指示标，禁止逐行套卡。
- 阴影、模糊、纹理只由材质层提供；业务代码禁止写 `shadow-*`、`backdrop-blur-*`。

## 动效

- 只消费语义别名：`--component-feedback-duration`（150ms）、`--component-disclosure-duration/easing`（220ms）、`--component-content-duration/easing`（220ms）、`--component-overlay-duration/enter-easing/exit-easing`（220ms）、`--component-layout-duration/easing`（320ms）。
- 禁止字面量 `duration-[…]`、禁止直读 `--motion-*`、禁止 `transition: all`；JS 动画经 `shared/motion.ts` 同源读取。
- 仅动画化 `transform` / `opacity`（折叠走 `grid-template-rows`，分栏收起走 `grid-template-columns`）；hover 位移/缩放须加 `@media (hover: hover) and (pointer: fine)` 门控；拖拽 `.is-resizing` 期间禁用过渡。
- 刻意不做：高频列表 stagger、流式消息入场、路由整页外壳过渡、Toast 节奏覆写。

## 常见迁移模式

| 手写（会被拦或违背规范） | 正确写法 |
| --- | --- |
| `rounded-md border border-border bg-muted/30 p-4` 信息块 | `<NoteBlock class="p-4">…</NoteBlock>` |
| `rounded-(--component-card-radius) border border-border p-3.5` 分区 | `<SectionBlock>…</SectionBlock>` |
| `div role="tablist"` 自定义 tab | `<Tabs><TabsList variant="pill"\|"underline"><TabsTrigger>` |
| `<CollapseReveal><div v-if="open">...</div></CollapseReveal>` | 去掉子节点 `v-if`，让内容常驻 DOM |
| `shadow-md backdrop-blur-sm`（悬浮按钮/弹层） | `data-surface="overlay"` + 语义过渡类 |
| `text-zinc-500` / `bg-black/60` | `text-muted-foreground` / `bg-(--component-image-scrim-bg)/60` |
| `duration-200` / 裸 `transition-opacity` | `transition-colors` 或 `transition-opacity duration-(--component-feedback-duration)` |

## 扩展契约

新语义变量 = 三处同步：`component-contract.ts` 默认值 → `materials.ts` 赋值 → `globals.css` 消费。新表面角色 = `materials.ts` 注册表 + `globals.css` 消费规则 + `scripts/check-design.mjs` 白名单三件套，优先复用现有五角色。
