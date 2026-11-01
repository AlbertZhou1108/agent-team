# 元素实现说明

2026-11-01：架构主入口是[公共组件配置与设计预设](../component-configuration.md)，本目录作为呈现设计资料。共享组件已接入实色、玻璃、纸质参数，开合与状态整改的最新进度见覆盖台账；下文早期缺口不作为当前状态声明。

本目录回答“同一类元素如何呈现和实现”。它引用[元素规格](../element-specifications.md)中的 E-GROUP、E-NAV、E-CONTENT，不另定义对象信息、状态或业务动作。

| 文档 | 职责 | 状态 |
| --- | --- | --- |
| 本文件 | 各材质共用的结构、交互实现和参数归属 | 现有机制与迁移约束 |
| [默认实色](solid.md) | 实色下的表面、状态和呈现方式 | 已有基线，部分统一待完成 |
| [玻璃](glass.md) | 玻璃下的光学、状态适配和回退 | 已有光学能力，内部状态适配待完成 |
| [纸质](paper.md) | 纸质下如何满足相同元素契约 | 首轮配置已接入，完整视觉验收待完成 |
| [覆盖台账](../element-implementation-coverage.md) | 实际使用处、实现缺口、验证证据 | 与上述定义分开维护 |

## 1. 共用实现

材质只更换呈现配方，不复制路由、选择、焦点管理、展开状态或 DOM 业务结构。共有能力由已有共享模块承担，各材质声明必要参数与差量；新增材质不能要求页面分别填写一套视觉值。

| 元素 | 共用实现的责任 | 现有代码落点 |
| --- | --- | --- |
| E-GROUP | 开合渲染、指示器同步、键盘与展开语义、隐藏交互和焦点恢复 | [GroupSidebar](../../web/src/app/layouts/GroupSidebar.vue)、[CollapseReveal](../../web/src/components/ui/collapse-reveal/CollapseReveal.vue)、[CollapsibleContent](../../web/src/components/ui/collapsible/CollapsibleContent.vue) |
| E-NAV | 独立接收 current/selected；组合悬停、按下、聚焦反馈；隔离菜单动作 | [SidebarEntry](../../web/src/app/layouts/SidebarEntry.vue)、[TeamRow](../../web/src/app/layouts/TeamRow.vue)、[GroupSidebar](../../web/src/app/layouts/GroupSidebar.vue) |
| E-CONTENT | 提供共享内容表面和用途适配；保留数据与对象导航的结构差异 | [TelemetryOverview](../../web/src/features/telemetry/TelemetryOverview.vue)、[TeamHome](../../web/src/features/groups/TeamHome.vue)、[Card](../../web/src/components/ui/card/Card.vue)、[Item](../../web/src/components/ui/item/Item.vue) |

以上是责任映射，不是接入完成声明。优先扩展已有模块，不预建一套替代组件库。

### 开合与状态组合

- E-GROUP 使用共享 Collapsible 或 CollapseReveal，不以裸 v-if 直接切换应当过渡的内容，不增加第三套高度动画。内容终点采用真实布局高度；减少动态效果时直接到达相同终态。
- CollapseReveal 只提供显隐能力；触发器的 ARIA、键盘及焦点恢复由共用分组实现负责。现有 CollapsibleContent 有嵌套限制，扩展前先检查源码。
- [Disclosure](../../web/src/components/ui/disclosure/Disclosure.vue) 的头部动作（#actions）只作用于子内容，收起时随内容一起不渲染（不可聚焦、不进可访问树），展开即恢复；使用处不需要也不能再自写开合条件。导航项（SidebarEntry）的菜单动作是 E-NAV 语义，不受此规则约束。
- E-NAV 先确定默认/current/selected 的基础状态，再叠加悬停或按下反馈；焦点提示独立保留。current + selected 时两个事实均可辨，不叠两块互相遮挡的底色。
- 实际交互决定 ARIA：当前位置使用 aria-current；aria-selected 只用于适合该属性的复合控件，不能机械加到所有按钮上。
- 数据刷新不重新播放整卡入场；目录主动作与排序、置顶等次动作继续隔离。

## 2. 参数和默认值的拥有者

组件库提供结构、variant、size 和基础布局；优先沿用已有默认值。主题持有语义颜色，材质持有表面工艺，动效持有节奏和曲线，密度/排印持有相应尺度。外观实现组合这些职责，不复制或改写其它维度的参数。

| 内容 | 事实来源 |
| --- | --- |
| 主题变量、状态层、时长、缓动、密度、阅读尺度 | [globals.css](../../web/src/styles/globals.css) 与现有主题/动效契约 |
| 各材质的角色配方、运动约束 | [materials.ts](../../web/src/theme/materials.ts) |
| 材质启用、清理和回退 | [apply.ts](../../web/src/theme/apply.ts)、[application.ts](../../web/src/theme/application.ts) |
| 具体元素如何消费上述能力 | 共享组件与本目录对应实现说明 |

高光宽度、纹理强度、选中层透明度、位置标记、阴影和曲线可以精细到数值，但只在负责它们的共享配方中定义一次。尚未验证的数值不成为既定默认，不在各页面补视觉覆盖。不得改变通用 Item muted 的全局含义来修补一种用途的状态。

## 3. 增加一种材质实现

引用同一元素 ID，说明各元素的默认呈现、状态差量、材质与其它维度的组合、能力回退和专属验收。共享结构和语义验收引用本文件及元素规格，不复制三份开合/选择逻辑。

新增表面角色或材质仍遵循[逻辑框架](../design-logic-framework.md)的登记流程。文档中的用途名称不自动成为 data-surface 值；配置可运行不表示全部使用处已完成视觉验收。

每份说明分别标记：代码已有能力、待实现的呈现、待视觉验证的参数。最终接入和证据只在覆盖台账登记。
