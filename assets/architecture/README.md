# 架构图说明

[返回产品介绍](../../README.md) · [技术架构](../../guide/architecture.md) · [宿主适配](../../guide/host-adapters.md)

本目录存放用于 `README.md` 与 `guide/` 文档的静态架构图（每张均提供浅色与深色版本，供 GitHub 按主题自动切换）：

- 中文版位于 `assets/architecture/`（基于提交 `05592efdb427082a7301efc4dea3565cf515220f`）。
- 英文版位于 `assets/architecture/en/`（基于提交 `7f78d1a64b3ad6afaad76b952a5dac880b1c9922`）。
- 源文件保留在本地 `.archify/`（已加入 `.gitignore`，不随仓库提交）。

| 文件前缀 | 主题 | 使用位置 |
| --- | --- | --- |
| `overview-{light,dark}.png` | 整体架构与边界 / Overview | [README.md](../../README.md) / [README.en.md](../../README.en.md)、[技术架构](../../guide/architecture.md) / [EN](../../guide/en/architecture.md) |
| `entry-{light,dark}.png` | 启动、单实例锁与三入口接入 / Startup & Entry | [技术架构](../../guide/architecture.md) / [EN](../../guide/en/architecture.md) |
| `pipeline-{light,dark}.png` | 消息调度、回合执行与恢复流水线 / Pipeline | [技术架构](../../guide/architecture.md) / [EN](../../guide/en/architecture.md) |
| `data-{light,dark}.png` | 聚合边界与本机 SQLite 存储 / Data & Aggregates | [技术架构](../../guide/architecture.md) / [EN](../../guide/en/architecture.md) |
| `web-{light,dark}.png` | 前端工作区装配与三通道数据流 / Web Panel | [技术架构](../../guide/architecture.md) / [EN](../../guide/en/architecture.md) |
| `hosts-{light,dark}.png` | 宿主声明、运行时设施与四家 CLI 适配器 / Host Adapters | [宿主适配](../../guide/host-adapters.md) / [EN](../../guide/en/host-adapters.md) |
