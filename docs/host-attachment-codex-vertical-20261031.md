# Codex 最小真实附件纵向验证

日期：2026-10-31。真实本机 Codex 0.158.0、真实项目 startServer / Bus / Panel Agent 消息 API。未改生产适配器、消息模型或前端。

## 链路与范围

验证脚本：[attachment-codex-vertical.mjs](../scripts/probes/attachment-codex-vertical.mjs)。手动运行（会消耗真实模型调用）：

```sh
node --disable-warning=ExperimentalWarning scripts/probes/attachment-codex-vertical.mjs
```

脚本在新建临时目录内生成随机 TXT 和两张不同顺序的六色 PNG，不依赖前一轮 /tmp 素材。需要已登录、具有可用模型目录的 Codex。本次 catalog 选择 `gpt-6-astra`；这是目录选择/请求模型，不证明 custom route 后的物理模型身份。使用实际 Panel Agent read-only 私人访问策略（shell 可用、view_image 禁用）。

localhost 随机端口的验证用网关：`POST /upload` 接收真实 HTTP 字节，保存到 workspace/attachments 下 UUID 文件，manifest 保存 id/type/size/SHA256/path；`POST /send` 查 manifest 并将附件路径写入文本，转发实际 `/api/panel-agent/messages`。正式项目尚无上传 API，这个网关不是生产功能。

## 两种适配器条件

1. **未修改适配器**：直接导入 `src/hosts/codex.mjs`。run 包装只观测日志，Bus、权限、工具、HTTP、消息持久化均为实际实现。
2. **原生图片实验条件**：从同一实际适配器复制一份到临时目录，只替换 turn/start 的一个 input 映射位置，为 text 后附加 localImage。相对 import 改为原项目绝对模块 URL 以便从临时目录加载。网关的附件 ID 经验证包装映射到 context.probeImages；这是**实验性接口缝隙**，不是当前生产 Bus 已支持附件上下文，也没有改源文件。

两种条件使用同一真实服务链路，原生条件保留其余适配器行为与策略、原来的会话 ID 和 policy signature。源代码匹配失败时探针会退出，防止未来静默替换错位置。

## 结果

证据根：`/var/folders/02/x9_f87tx6pz9f62fm7ptn18m0000gn/T/attachment-codex-vertical-In2R4I`。

| 用例 | 结果 |
| --- | --- |
| TXT / PNG 上传 | HTTP 200，真实文件和 manifest 落盘，随机 UUID 与 SHA256 保存 |
| 实际原适配器读取 TXT | HTTP 200，commandExecution 通过 cat 读取实际上传文件，随机 24 位口令准确 |
| 实际原适配器读取 PNG 路径 | HTTP 200，模型用 shell 的 base64 输出 PNG，回答 green/red/purple/blue/orange/yellow 全顺序正确；没有观察到原生 image 输入或 view_image 工具 |
| 关闭并重建网关、startServer、Bus、adapter | 原 manifest/附件与 SQLite 会话保留；新服务再次真实读取 TXT，返回相同口令和正确 46 字节长度。事件证明新 commandExecution，不只依赖记忆 |
| 原生实验映射发送新 PNG | 真实 HTTP 消息链路，实验适配器 turn/start localImage，回答 red/purple/orange/green/blue/yellow 正确；该回合无读取命令 |
| 原生映射再次重建服务 | 重新读 manifest 后发另一个已存附件 ID；turn/start localImage，正确识别第一张图全部颜色，无读取命令 |
| 非 PNG 字节声明为 PNG 上传 | 验证网关检查签名，HTTP 422；没有进入模型或正式消息接口。仅签名校验，不是完整图片解码校验 |
| 未知附件 ID | 网关返回 HTTP 400，没有进入正式消息接口 |
| 持久化一致性 | 三个存储附件的 SHA256 全部与 manifest 一致 |

自动核验 `assertions.json` 全部通过。`summary.json` 为结果，`events.jsonl` 为实际适配器收到的宿主事件，`calls.jsonl` 记录权限和旧 session，`manifest.json`、`expected.json` 用于独立复核。`data/` 是项目运行期私有数据，含内部端点密钥等，不分发。测试结束后服务与网关均已关闭。

第一轮还用前轮已存在的素材执行过同样链路；为避免重复素材影响证据，本文主要结论采用第二轮全新随机素材。重建后的 event 和 userMessage 原生输入可在 events.jsonl 查证。

## 判断和限制

- 文本上传—持久化—真实消息 API—Bus—适配器—宿主读取—服务重建后重新读取，实际通过。
- 原适配器的图片路径测试此次成功，但走的是 base64 shell 文本输出；不据此承诺为可靠图片接口，也不能等同原生图片能力。之前无工具对照不可读，见[宿主能力报告](host-attachments-codex-verification.md)。
- 只改一处输入映射后的原生图片纵向验证成功，说明可用一个明确的 adapter 输入接口接入，但正式 Bus 尚未传递附件、未记录结构化附件元数据。
- 目前历史消息仅保存上传路径文本。没有实现附件关联表、持久化引用管理、删除策略、过期清理、并发控制或生产错误状态。
- 网关只用于手动验证，1MiB 限制、PNG 签名检查，不提供生产鉴权、流式限流或完整格式验证。文件位于本机允许的私人工作区，不能推广为远端宿主或任意路径读取权限。
- 本轮没有真实 coordination communication 权限负例；前轮宿主无工具对照是不同层级的证据，不能算成本轮 Bus 权限验收。
- 未测试 PDF/DOCX、源文件删除后的行为、上下文压缩、大文件和并发。原生实验成功不等于完整附件功能已经实现。

后续脚本新增对同样结果的自动断言，已对本轮保存结果单独运行核验通过，语法与 ESLint 通过；没有为无语义变更重复消耗模型调用。
