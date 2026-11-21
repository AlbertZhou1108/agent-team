---
name: design-system
description: AgentTeam 前端设计体系操作手册：写或改 web/src 的页面与组件时使用，提供圆角刻度、颜色、表面、动效的语义档位对照与常见迁移模式，避免手写样式绕过设计体系。
---

# AgentTeam 设计体系速用手册

设计基线在 `DESIGN.md`（产品气质与规则），契约在 `web/src/theme/component-contract.ts`（约 70 个 `--component-*` 变量），材质规格在 `web/src/theme/materials.ts`（材质 × 表面角色）。本手册只回答"写代码时要 X 用 Y"。

## 自查（每次改完 web/src 都跑）

```bash
node scripts/check-design.mjs   # 全树约 0.3s,违例明细带文件行号
```

## 圆角刻度（随材质取值,组件按语义取档）

| 档位 | 变量 | 语义 | 经典 | 玻璃 | 纸 | 活力 |
| --- | --- | --- | --- | --- | --- | --- |
| panel | `--component-panel-radius` | 面板/内容面/浮层 | 8 | 8 | 7 | 22 |
| card | `--component-card-radius` | 面内嵌卡/消息卡/空态/投放区 | 12 | 12 | 12 | 16 |
| control | `--component-control-radius` | 按钮/输入/toggle | 6 | 8 | 4 | 14 |
| chip | `--component-chip-radius` | 徽章/菜单项/交互行/小件 | 6 | 6 | 4 | 10 |

写法：`rounded-(--component-card-radius)`。禁止 `rounded-sm/md/lg/xl/2xl/3xl` 字面量；`rounded-full`（胶囊/头像）、`rounded-none`、`rounded-xs`（不随材质的几何微装饰，如 tooltip 箭头）例外。

## 颜色

- 只消费语义 token：`--background/--foreground/--card/--popover/--primary/--secondary/--accent/--muted(-foreground)/--border/--input/--ring` 与状态四色（`--success/--warning/--info/--destructive` + 各自 foreground）。
- 派生用 `color-mix(in oklch, var(--primary) 9%, var(--card))` 任意比例，明暗自动各得一套。
- Tailwind 调色板类（`text-zinc-500`）与裸 `black/white` 禁止。
- 叠在任意亮度图片上的控件用压印层 token：`--component-image-scrim-fg` / `--component-image-scrim-bg` + 透明度修饰符（如 `text-(--component-image-scrim-fg)/85`）。
- 例外区（数据级色板，内容而非样式）：`shared/team-colors.ts`、`features/messages/identity.ts`。

## 表面与容器

- 容器级表面用 `<Surface role="…">`：`nav-panel`（导航）/`context-panel`（右栏详情）/`action`（会话头/输入/运行卡）/`input`（输入框）/`overlay`（菜单/弹窗）。role 必填、类型化，材质的底/纹/糊/影/折射由 `materials.ts` 按角色提供，页面不得自写。
- 内容面卡片用 `Card`（自带 `data-component='content-surface'`）；普通消息卡用 `Bubble/BubbleContent`。
- **区域内不造边框卡片**：分组用小标题、分割线、间距；弱提示/次级信息块用 `NoteBlock`（muted 底色 + card 圆角，无边框）。
- 阴影、模糊、纹理、折射只由材质层（`materials.ts` roles）提供；业务代码不写 `shadow-*`、`backdrop-blur-*`。

## 动效

- 只消费语义别名（时长按变化面积分档，缓动按用途分档）：`--component-feedback-duration`（悬停/按压）、`--component-disclosure-duration/easing`（折叠）、`--component-content-duration/easing`（内容出现）、`--component-overlay-duration/enter-easing/exit-easing`（浮层进出）、`--component-layout-duration/easing`（大面积结构）。
- 禁止字面量 `duration-[…]` 与直读 `--motion-*`；JS 动画经 `shared/motion.ts` 取档。
- 刻意不做：消息流入场、页面外壳过渡、Toast 节奏、列表重排。

## 常见迁移模式

| 手写（会被拦） | 正确写法 |
| --- | --- |
| `rounded-md border border-border bg-muted/30 p-4` 信息块 | `<NoteBlock class="p-4">…</NoteBlock>` |
| `rounded-xl` 消息卡 | `BubbleContent`（自带 card 档） |
| `bg-popover rounded-md shadow-md`（浮层） | `PopoverContent` 等 ui 原语（`data-surface='overlay'` 由材质层供样式） |
| `text-zinc-500` | `text-muted-foreground` |
| `bg-black/60`（图片浮层控件） | `bg-(--component-image-scrim-bg)/60` |
| `duration-200` | `transition-colors`（不写时长,根上已改指契约 fast 档） |

## 扩展契约

新语义档位（新变量）= 三处：`component-contract.ts` 默认值 → 各材质表赋值 → globals.css 消费。新表面角色 = 注册表 + globals.css 消费规则 + `check-design.mjs` 注册表三件套，优先复用现有五角色。
