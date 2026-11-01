# 前端分层架构:样式与外观的技术组织

2026-11-01 配置入口：[公共组件配置与设计预设](component-configuration.md)。`component-contract.ts` 声明五维默认参数，`design-presets.ts` 定义设计预设并解析差量，`materials.ts` 提供材质配方。`applyAppearance()` 同时服务首帧和响应式更新。共享组件消费 `--component-*`，不判断预设 ID；设置页选择配置，个人阅读偏好独立保留。新增预设在已有能力范围内只增加配置；新增引擎效果仍须实现能力。本次状态以覆盖台账为准，下文历史缺口由台账更新。

本文说明前端样式的分层结构与外观维度的传播机制,回答"我想改 X 应该改哪一层"。上游是[设计逻辑框架](design-logic-framework.md)(元素的逻辑描述模型:方面、状态、角色、决策层级 —— 本文各层是该框架的技术投影);设计规则(应该长什么样)见 [DESIGN.md](../DESIGN.md)。配套使用:先逻辑定位方面与决策层级，再按[元素规格](element-specifications.md)确定用途与状态，按[元素实现说明](element-implementations/README.md)选择具体呈现，最后在本表定位代码层级；接入情况独立记录到[覆盖台账](element-implementation-coverage.md)。

## 1. 六层总览

页面上的每个元素都是六层叠加的产物,数据流自下而上、单向:

```
第0层 Tailwind 引擎            工具类 = 档位 + 变量引用(bg-card、rounded-md)
第1层 变量契约(globals.css)   :root/.dark 写 29 个语义变量默认值;@theme inline 接入引擎
第2层 主题解析(theme/)         主题包(29 token,含 radius)→ resolve → apply 全量覆写 <html> 变量
第3层 外观维度(applier)        <html> 上的开关:.dark、data-material、data-motion、
                               data-density、--reading-*/--code-size(内联样式)
第4层 shadcn 组件(components/ui) 挂"档位类"、读"语义变量";自身不决定任何具体视觉值
第5层 共享样式(globals.css 其余) 结构骨架(.app-shell/.workspace-shell)、角色表面
                               (.markdown-content/.run-card)、维度与组件之间的桥
第6层 业务组件(features/pages) 只做组合与布局;不决定颜色、圆角、时长、缓动
```

## 2. 各层契约

| 层 | 拥有 | 禁止 |
| --- | --- | --- |
| 第0层 引擎 | 工具类生成 | — |
| 第1层 契约 | 变量名清单(TOKEN_KEYS 29 项)与默认值;@theme 映射 | 出现具体业务色值之外的字面量 |
| 第2层 主题 | 主题包数据、解析、回落、首帧快照 | 直接操作组件或 DOM 元素(只写 `<html>` 变量与 .dark) |
| 第3层 维度 | 六个维度的解析与开关写入(applier) | 跳过 applier 直接改样式;把维度值写进组件 |
| 第4层 组件库 | 档位类(variant/size)、语义变量消费、动效契约变量消费 | 写死色值、时长常量、dark: 前缀业务覆盖 |
| 第5层 共享样式 | 结构布局、角色表面排版、维度消费规则(属性选择器) | 组件内部细节;与第4层重复的声明 |
| 第6层 业务 | 布局组合、业务差异 | 覆盖基类视觉、页面级字号/颜色/圆角尺度 |

单一出口原则:所有维度的最终写入口只有 theme/apply.ts(main.ts 首帧 + application.ts watcher),任何绕过 applier 的样式写入都是架构违规。

## 3. 外观维度机制表

| 维度 | 写入(`<html>`) | 传播机制 | 消费点(实证) | 新增档位的步骤 |
| --- | --- | --- | --- | --- |
| 明暗 | `.dark` | 变量双值(:root/.dark) | 全部语义工具类自动 | — (已有三态) |
| 主题 | `--background` 等 29 变量 | resolve 后全量覆写 | 全部语义工具类自动 | 加主题包(builtin 或上传),组件零改动 |
| 材质 | `data-material` | 角色属性选择器(见 §4) | 导航/上下文/操作/输入/浮层 + 样例钩子 | 在各角色声明该材质的渲染 |
| 动效 | `data-motion` | `--motion-pace` + 时长/缓动契约变量 + kill-switch | globals 28 处 + 组件 5 处 + JS motionPace() | 风格档:重映射 pace/曲线;新用途:挂契约变量 |
| 密度 | `data-density` | `--density-*` 5 个变量 | 共享表面 padding/min-height | 加一档变量组,消费面自动跟随 |
| 阅读 | `--reading-*`/`--code-size` 内联 | CSS 变量 | .markdown-content、正文宽度、代码字号 | 加一档映射值 |

### 九机制:逻辑框架的技术投影

逻辑框架([设计逻辑框架](design-logic-framework.md))的每个概念都推演出一个技术承载物;推演判据:逻辑的每条规则都要能指出"谁在技术层执行它"。九机制及现状:

| 机制 | 承载物 | 机制状态（不代表全站覆盖） |
| --- | --- | --- |
| M1 角色注册表与接口 | SURFACE_ROLE_REGISTRY(含可供性需求)+ data-surface | 表面角色已建立；交互用途和覆盖需由元素规格补充 |
| M2 材质规格表 | theme/materials.ts(角色配方、组件状态参数、运动签名) | 实色/玻璃/纸质及共享导航状态层、内容底面已接入；验收见台账 |
| M3 阶段化解析链 | application.ts apply()(环境第 0 步 + 依赖序分段) | 完整 |
| M4 消费变量族 | --surface-*/--state-*/--density-*/--reading-*/--motion-* | 完整 |
| M5 跨方面联合解析 | 材质运动签名经 data-material-spring 对动效契约变量的材质级重映射 | 完整(机制;新大类按需填充) |
| M6 状态差量系统 | --state-* 令牌 + [role-statecharts](role-statecharts.md) 差量登记 | 基础机制已建立；复合状态配方与使用处尚未统一 |
| M7 治理检查 | scripts/check-design.mjs(接入 npm run check) | 检查部分命名与字面量，不验证角色覆盖、开合一致性或视觉 |
| M8 角色状态图文档 | docs/role-statecharts.md | 通用状态清单已建立；类级状态组合见元素规格 |
| M9 生命周期与离场渲染 | Vue Transition 按需包裹 + CSS 挂载动画 | 按需(离开动画无全覆盖) |

预留扩展:编舞时序令牌(stagger)、组件级令牌(克制使用)、页面级场景密度覆盖(Carbon productive/expressive 启示)。

元素规格只定义用途、内容、状态、动作与语义约束。公共组件消费五维配置，预设提供差量与角色/状态配方；页面声明内容与独立状态。优先扩展现有模块，避免只为传递参数增加包装。纸质已作为第二套配置接入；按共同语义与对应实现核对使用处并记录证据后，才能标记覆盖验收完成。

## 4. 表面角色体系(材质的作用域机制)

**材质按角色与共享组件状态配方消费，不按页面复制。** 表面经 `Surface` 声明类型化角色，applier 输出 `--surface-{role}-*`；导航状态层与内容单元消费注册的 `--component-*`。未接入的表面继续走主题基线，组件不判断具体预设 ID。

**结构能力中立化(2026-11-01)**:会话操作区是 **sticky-in-scroller overlay**(header/composer 经 MessageFeed `bar-top`/`bar-bottom` 插槽落在滚动区内,sticky 载体必须是滚动列的直接子元素 —— 见 `.conversation-bar-bottom` 注释),所有材质共用;玻璃下内容穿越可见,实色下即普通工具栏。回底按钮锚在 viewport 层,垂直偏移按底栏实高注入(ResizeObserver,见 ConversationScroller `measureBars`)。

会话滚动使用 Reka ScrollAreaViewport + 项目 ScrollBar 原语:覆盖式滚动条不占布局槽位,顶/底栏不使用负边距补偿。轨道按顶栏与输入区实高避让,保留 sticky 下穿能力、键盘滚动与原有跟底/锚点逻辑。

| 角色 | 当前载体 | 玻璃大类渲染 | 现状 |
| --- | --- | --- | --- |
| 应用背景 | `body` 固定背景 | 静态环境色;玻璃模式下 app-shell 透明 | 已接入 |
| 导航面板 | `Surface role="nav-panel"`(GroupSidebar,12px 外边距) | 54% card;边缘折射 18px | 已接入 |
| 上下文面板 | `Surface role="context-panel"`(右栏、嵌入式设置) | 与导航面板同配方 | 已接入 |
| 会话操作区 | `Surface role="action"`(header/展开输入区) | 46% card;边缘折射 20px | 已接入 |
| 输入面 | Input/Textarea/InputGroup/SelectTrigger 原语 | 82% card;独立时折射 10px,嵌套时复用父层光学 | 已接入 |
| 阅读面 | 正文/代码/表格(bg-card 系) | 实色,前景不参与位移 | 已声明 |
| 浮层 | Dialog/Popover/DropdownMenu/Select 原语 | 84% popover;折射 14px,更强背景模糊 | 已接入 |
| 媒体浮层 | 图片灯箱 | 黑底白字,与主题无关 | 刻意独立 |

`theme/glass-refraction.ts` 在已验证的 Chromium 路径上为角色表面创建独立 SVG backdrop 滤镜;参数来自规格表 `refraction`。`refraction-map.ts` 由圆角距离场生成边缘法线图(中心零位移),纹理每轴不超过 1024。ResizeObserver 按布局尺寸更新,MutationObserver 接入传送浮层并清理已移除表面;切实色/降低透明度/卸载时删除滤镜与内联变量。非 Chromium 保留原模糊玻璃回退;不以 CSS.supports 的语法结果宣称跨浏览器效果支持。整个过程不使用前景 filter、不修改布局或发送行为。局部高光由 glass-light.ts 按交互驱动,减少动态效果时关闭。

已认可的原型保存在本地分支 `codex/prototype-liquid-glass-refraction-20261101`,常规页面不保留原型路由和切换器。

已知边界:主区卡片直接消费 `bg-card` 而无 `data-surface`(阅读角色经规格表声明为实色,当前等价)。若未来某材质需要纹理化阅读面:在规格表该材质的 reading 格子声明渲染,并给 bg-card 消费面补 `data-surface="reading"` —— 材质定义层的一次性扩展,组件依旧零改动。

## 5. 修改指南(决策表)

| 我想改… | 改哪一层 | 影响面 |
| --- | --- | --- |
| 某类动画的时长/手感 | 第3层动效契约(--motion-duration-*/pace) | 全部消费该档的组件自动跟随 |
| 全局动效风格 | 第3层风格块(globals.css soft/lively 重映射) | 一处改,全部维度生效 |
| 材质观感 | 第5层对应角色的材质规则 | 该角色所有表面 |
| 让材质覆盖新表面 | 用 `Surface` 组件承载表面(role 必填)+ 规格表该材质加一格 | 该表面 |
| 主题颜色 | 第2层主题包(builtin.ts 或上传) | 全部语义色自动 |
| 密度间距 | 第3层 --density-* 变量组 | 共享表面自动 |
| 阅读排版 | 第3层 --reading-* 映射表 | 正文/代码自动 |
| 结构布局(壳/面板) | 第5层结构骨架(.app-shell 系) | 对应结构 |
| 单组件默认形态 | 第4层该组件(components/ui) | 该组件全部使用处 |
| 新增外观维度 | 第3层 applier + 第5层消费规则 + 样例卡同步 | 遵循"可感知性同步"纪律(见下) |

## 6. 演进纪律

1. **可感知性同步**:新维度落地必须同步样例卡(AppearanceSample)与真实表面消费,验证以肉眼可感知为准(教训:维度写进 `<html>` 但无人消费 = 无效功能)。
2. **禁止并存双套**:新规则生效即清理被替代路径(如折叠动画已从测量关键帧整体迁到 grid-rows,不允许两套并存)。
3. **组件禁止自带常量**:时长读动效契约、颜色读语义变量、圆角读 radius 链;发现字面量按台账迁移。
4. **改折叠组件前先读实现注释**:CollapsibleContent 是 grid-rows 架构(forceMount + 根节点 data-state 祖先选择器),不支持嵌套折叠,勿改回 reka 测量值关键帧(过冲根因,见台账 §6)。
5. **设置交互为点击即生效**:外观选项改偏好立即生效,不引入预览/确认两套状态。

相关:[DESIGN.md](../DESIGN.md)(设计规则)、[收敛计划](frontend-design-convergence-plan.md)与[台账](frontend-design-convergence-audit.md)(过程与实证)、[主题包契约](shadcn-vue-agent-integration.md)。
