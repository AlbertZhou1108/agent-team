# 附件最小真实纵向验证

日期：2026-10-31。基于[宿主能力验证](host-attachment-verification-20261031.md)，本轮增加真实上传、持久化、项目消息接口/Bus、实际适配器以及服务重建。没有实现生产附件 API、消息附件 schema 或完整 UI。

## 结论

**本地附件落盘后，通过现有 Panel Agent 私人工作区读取的方案，在三个实际适配器中可行。** Codex 的原生图片映射另以临时适配器副本验证可行。可以进入正式附件契约和实现设计，但实验上传网关不可直接视为生产实现。

共同链路：真实 HTTP 上传字节 → 独立 localhost 验证网关持久化 → 正式 `/api/panel-agent/messages` → `Bus.panelPrivateTurn` / `runPanelTurn` → 实际宿主适配器 → 文件工具/实验原生输入 → 真实回答和项目消息历史。所有测试使用独立数据、工作区与会话；没有发送用户文件，没有改用户配置。

| 验证项 | Codex | Claude Code | DSH |
| --- | --- | --- | --- |
| 原适配器 TXT 上传后读取 | 通过，有实际 shell 读取 | 通过，有实际 Read | 通过，有实际 read |
| 原适配器 PNG 路径读取 | 本次成功，经 base64 shell 文本，不作为可靠图片接口承诺 | 通过，Read 图片 | 通过，headless read_image |
| 服务/Bus/adapter 全重建后重新读取 | 通过，新的命令事件和正确字节长度 | 通过，新的 Read 事件、同 session | 通过，新的 read/read_image 事件 |
| 原生图像纵向映射 | 临时复制真实 adapter，只替换一个 input 映射，两个服务生命周期均通过 | 本轮未改原 adapter 为原生图片；前轮宿主已测 | 本轮保留 headless；ACP仅前轮宿主已测 |
| 坏图 | 网关 PNG 签名检查返回422，不进宿主；宿主坏图行为见前轮 | Read is_error，但外层回合成功 | read_image status:error，但HTTP200 |
| communication 禁读对照 | 本轮未测真实Bus场景，前轮宿主对照不可读 | 真实 Panel-led 团队 coordination，通过：无Read、UNAVAILABLE | 同真实适配器 host.run 直接测试，通过；不算完整Bus团队场景 |

本轮实际 Codex 目录选择 `gpt-6-astra`；Claude assistant.model 为 `deepseek-v4-flash`；DSH 请求路由为 `deepseek-official/deepseek-flash`。这些不是对所有模型的承诺，也不是对中间网关最终物理模型的独立鉴定。

## 本轮确认的设计边界

1. **持久化文件路径方案有效，但依赖权限和本机共享文件系统。** 只读指宿主不可写，并不妨碍上传服务把文件存入专门目录；不能据此开放整个文件系统或让 communication 模式自动获得文件读取权。
2. **原生图像与文件工具读取应分开建模。** Codex 临时输入映射证明可以用小的 adapter 接口接入，尚需让正式消息/调度层传递结构化附件。Claude、DSH路径读取成功不代表它们的生产adapter已具备原生图片字段。
3. **附件需要独立处理状态。** HTTP200/回合成功既可能代表“正确读到图片”，也可能代表“模型正确报告读取失败”；框架不能把两者视为同一个附件成功状态。
4. **服务重建不会自动丢失素材。** 本轮 manifest/文件/宿主session保留后可重读，但生产中仍要设计消息关联、引用存续、过期清理和删除后的错误行为。
5. **这不是生产上传端到端验收。** 验证网关仅接受少量本地样例，无正式权限/归属、完整解码、下载/删除、并发、重试、传输中断、大小/类型矩阵；没有正式前端。

## 可复现产物

三个脚本均为手动真实推理探针，运行会消耗已有宿主额度，不加入默认测试。测试使用自制随机素材；DSH的首次随机PNG已作为固定复现素材保留。内部运行数据可能含项目端点密钥，不作为公开证据分发。

- [Codex 报告](host-attachment-codex-vertical-20261031.md) / [探针](../scripts/probes/attachment-codex-vertical.mjs)
- [Claude Code 报告](host-attachment-claude-vertical-20261031.md) / [探针](../scripts/probes/attachment-claude-vertical.mjs)
- [DSH 报告](host-attachment-dsh-vertical-20261031.md) / [探针](../scripts/probes/attachment-dsh-vertical.mjs)

报告各自记录运行目录、调用参数、结果和范围。原始日志位于临时目录，可能被操作系统清理。本轮结束后各临时服务/网关/测试宿主已关闭。探针语法检查、针对探针的 ESLint、git diff --check 通过；未运行无关的完整UI/核心套件，也未触碰此前已有的未提交UI改动。
