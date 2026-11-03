# README 图片说明

[返回产品介绍](../../README.md)

## 实机截图

截图日期：2026-11-03。版本：Agent Team v0.2.0。使用独立临时数据目录与虚构读书会场景，不包含真实客户或参与者数据。截图为浏览器原始画面，没有用图片生成工具补绘界面或伪造消息。

| 文件 | 场景 |
| --- | --- |
| `01-connect.png` | 首次引导，检测本机 Codex、Claude Code、DSH 的通信状态 |
| `02-private-assistant.png` | 真实私人助手问答 |
| `03-user-choice.png` | 主 Agent 发出的真实选择卡 |
| `04-workbench.png` | 团队执行时的工作台 |
| `05-members-and-review.png` | 成员资料及修订反馈 |
| `06-review-feedback.png` | 独立读取简报和方案后提出的审阅意见 |
| `07-pair-conversation.png` | 活动策划与风险审阅之间的会话 |
| `08-message-search.png` | 搜索实际演示消息 |

演示使用 Codex 与 Claude 宿主真实调用模型，DSH 仅展示通信检测。部分步骤由当前 CLI 创建和发起，截图不表示全部步骤都由页面完成。场景中特意要求发出选择卡，以展示该交互。执行过程中出现容量及额度错误，后续复核未完成；文件与策划消息的预算存在差异。没有清理错误记录或伪造成功结论。Token 统计仅属于本次运行，不代表典型费用、性能或质量。

## 概念插画

以下两张图片使用 **Codex 内置 imagegen** 生成，均为概念插画，不是软件截图、真实活动照片或已实现界面。生成后直接保存为 PNG，未用于替代实机证据。

### collaboration-hero.png

最终提示词：

```text
Use case: stylized-concept. Asset type: wide editorial illustration for the Chinese README of Agent Team, a local single-user multi-agent collaboration product. Primary request: illustrate one person guiding a small team of AI assistants from a brief to a coherent deliverable. Calm architectural paper sculpture / precise isometric editorial illustration, on warm off-white background. One laptop-sized local workspace in the middle, three distinct small abstract agent stations arranged around it, linked by restrained fine message paths; each station contributes a small paper note to a single neatly assembled document. Abstract forms only, not literal software interfaces. Soft graphite, stone, muted jade accents, subtle paper texture and gentle shadows. Horizontal panoramic composition with generous breathing room, polished and readable as a GitHub README banner. No text, no logos, no fake screenshots, no robots, no glowing sci-fi circuitry, no decorative metrics or invented UI. This is explicitly a conceptual illustration, not a product photo.
```

### brief-to-plan.png

最终提示词：

```text
Use case: stylized-concept. Asset type: secondary editorial illustration strip for Agent Team README, accompanying a real demonstration about planning a community reading club. Primary request: visualize a written brief becoming a considered, usable event plan through contributions and review. Three quiet connected paper-sculpture vignettes across a wide warm off-white canvas: left an open book with a single brief note and pencil; middle several distinct contribution cards arranged around a shared planning sheet, one small magnifying glass suggesting review; right a neatly assembled booklet with a small abstract clock and modest material tokens, suggesting a usable activity plan. Precise isometric editorial illustration, tactile ivory paper and stone, graphite lines, muted jade accents, soft daylight shadows. Restrained and spacious, visually consistent with a calm local collaboration workbench. No text, no logos, no fake software UI, no people portraits, no robots, no charts or numerical claims. This is a conceptual illustration, not a real event photograph or software screenshot.
```
