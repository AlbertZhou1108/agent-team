# 架构图说明

[返回产品介绍](../../README.md) · [技术架构](../../guide/architecture.md) · [宿主适配](../../guide/host-adapters.md)

本目录存放用于 `README.md` 与 `guide/` 文档的静态架构图（每张均提供浅色与深色版本，供 GitHub 按主题自动切换）。

- 生成来源：基于提交 `05592efdb427082a7301efc4dea3565cf515220f` 的代码结构，通过 Archify 校验并经无头浏览器渲染导出。
- 源文件保留在本地 `.archify/`（已加入 `.gitignore`，不随仓库提交）。

| 文件前缀 | 主题 | 使用位置 |
| --- | --- | --- |
| `overview-{light,dark}.png` | 整体架构与边界 | [README.md](../../README.md)、[技术架构](../../guide/architecture.md) |
| `entry-{light,dark}.png` | 启动、单实例锁与三入口接入 | [技术架构](../../guide/architecture.md) |
| `pipeline-{light,dark}.png` | 消息调度、回合执行与恢复流水线 | [技术架构](../../guide/architecture.md) |
| `data-{light,dark}.png` | 聚合边界与本机 SQLite 存储 | [技术架构](../../guide/architecture.md) |
| `web-{light,dark}.png` | 前端工作区装配与三通道数据流 | [技术架构](../../guide/architecture.md) |
| `hosts-{light,dark}.png` | 宿主声明、运行时设施与四家 CLI 适配器 | [宿主适配](../../guide/host-adapters.md) |
