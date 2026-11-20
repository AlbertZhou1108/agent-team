# Desktop integration handoff(2026-11-20 更新)

> 本文档是桌面集成工作的唯一交接入口。实现(Phase 1-6)与第一轮真宿主验收均已完成并提交;
> 后续由其它 Agent 接手时,先通读本文,再按「剩余工作」的优先级推进。产品决策以
> [ADR 0010](adr/0010-desktop-controller-boundary.md)、[ADR 0011](adr/0011-desktop-first-rollout.md)、
> [ADR 0012](adr/0012-desktop-controller-workspace-follows-conversation.md) 与
> [GLOSSARY.md](../GLOSSARY.md) 为准;实施计划细节见
> [desktop-integration-plan-2026-11-19.md](desktop-integration-plan-2026-11-19.md)(§7 验收矩阵与 §8 发布门仍然有效)。

## 当前状态

- 分支 `main`,HEAD `2696617`,**9 个 commit 未推送**(92b0bcc → 2696617,列表见下),工作区干净。
- `SCHEMA_VERSION = 22`(v20 桌面域基础 → v21 应用停用与 bundle 版本 → v22 binding_kind)。
- 门禁全绿:`npm run check` + `npm test`(后端 node:test 487 用例、前端 vitest 66 文件全过)。
- Commit 索引(实现+验收按序):
  - `f710ce0` Phase 1 领域/存储基础(v20):desktop_applications、team_controller_relations(活跃席位由 team_lead_controllers 推导,不存双份)、workspace_events、binding 的 surface/controller_cwd、groups 的 workspace_pending/revision;control_teams 按关系收口、同用户按 teamId 接管、workspace 跟随(立即生效/pending 结算+成员会话失效)。
  - `62b9dbc` Phase 2 发现与验证框架(v21):`src/desktop/`(definitions/detect/verify/status/manage)、指纹重验证、额度确认门、临时目录+看门狗+进程树清理、`/api/desktop/*`、CLI `desktop` 命令。
  - `53819ff` Phase 3 Codex 切片(v22):激活连接(binding_kind conversation|activation)、每线程解析、config.toml 受管 TOML 块安装、Codex 验证策略、codex 宿主工厂 env 注入。
  - `0795d60` Phase 4+5 DSH/Claude 切片:desktopConversationIdentity 通道(codex=thread/dsh=manual/claude=app)、Claude JSON 安装、DSH 手动桥接、两家验证策略。
  - `9677305` Phase 6 面板:设置页「桌面应用集成」区(状态/验证两步额度确认/接入结果/停用启用移除)。
  - `f316d6b`、`2696617` 真宿主验收修复(见下「验收结论」)。

## 核心机制速览(接手者必读)

1. **激活连接(v22)**:桌面宿主配置只能放一条全局 MCP 凭据,所以安装写入 binding_kind='activation' 的激活连接;控制面按 hosts/definitions.mjs 的 `desktopConversationIdentity` 通道解析出会话连接(binding_kind='conversation'):
   - codex=`thread`(按 CODEX_THREAD_ID 一线程一连接;但**桌面聊天的 MCP 子进程不注入线程身份**,见下);
   - dsh=`manual`(MCP 子进程无会话身份,须 bind-session 显式绑定,未绑定前拒绝并给指引);
   - claude=`app`(无身份通道,应用级单连接;声明能力刻意不含 session.wake → Pull-only)。
2. **回落语义**:无线程身份的调用回落到该激活连接**最近绑定的**会话连接(名字前缀限定,不跨接入串);一次都没绑定时报错并指引 bind-session。已知限制:并发桌面会话共享最近绑定(后绑定者赢)——如实呈现,等宿主未来注入身份后收严。
3. **桌面接入走插件机制(实测确认)**:Codex Desktop 聊天宿主(code mode)**不读** config.toml 的 `[mcp_servers.*]`(那是 CLI/`codex exec` 侧的,验证引擎检查依赖它)。桌面正解:
   - `~/.codex/plugins/cache/<source>/<plugin>/<version>/.mcp.json`(command/args/env + `enabled:true` + `default_tools_approval_mode`)与可选 `.codex-marketplace-install.json`;
   - config.toml 加 `[plugins."agent-team@agent-team"] enabled = true`;
   - 重启应用生效。acceptance 时已手工装好(目录 `~/.codex/plugins/cache/agent-team/agent-team/0.5.0/`),**installCodexDesktopIntegration 还没固化这一步**(当前只写 config.toml 受管块,对 CLI 有用)——下一步第一项。
4. **会话绑定流程(桌面会话内)**:shell `echo $CODEX_THREAD_ID`(桌面 shell 注入✓)→ 读插件 .mcp.json 拿 client/socket/key → `AGENT_TEAM_CLIENT_KEY=<key> node src/cli.mjs bind-session --socket <socket> --client <client> --session <线程号>` → 之后 MCP 调用回落到该会话连接。bind-session 后 control_status 经插件 MCP 真实返回(实测 isError:false)。
5. **验证框架**:verifyDesktopApplication 统一编排(额度确认门 → 隔离临时目录 → 看门狗 → 进程树清理 → 全有全无落库);各宿主策略在 definitions 顶层(verifyController/verifyEngine,由 desktop/index.mjs Object.assign 挂载——挂载点有回归测试钉住)。spawnTracked 必须 `stdio:['ignore','pipe','pipe']`(codex exec 在挂起管道上永久等 stdin)。
6. **workspace 跟随**:桌面会话 cwd 变化 → requestControllerWorkspace(运行中回合 → pending,canRun 拦截派发,pump 结算并失效成员会话)。

## 真宿主验收结论(2026-11-20,真实额度,用户已授权)

面板驱动检查(设置页,真实引擎回合)。2026-11-20 14:35 三家同批复验均通过(Codex 17.1s,Claude/DSH 十余秒);Codex 首轮失败为执行沙箱的批量删除保护伪影,见「已知限制与风险」。

| 应用 | 接入 | 验证 | 结论 | 备注 |
| --- | --- | --- | --- | --- |
| Codex Desktop | ✅ config.toml 受管块+备份 | ✅ 27s | **可用** | 隔离 CODEX_HOME + auth.json 符号链接有效;主控工具可调用+引擎短任务完成 |
| Claude Desktop | ✅ 只占 mcpServers.agent_team 键 | ✅ 18s | **可用,仅手动查看消息(Pull-only)** | 内嵌引擎 2.1.326(运行时下载于 `~/Library/Application Support/Claude-3p/claude-code/<版本>/<hash>/claude.app/Contents/MacOS/claude`) |
| DSH Desktop | ✅ 手动桥接配置返回 | ✅ 10s | **可用**(2026-11-20 复验) | 修复前验证回合未注入 `DEEPSEEK_API_KEY` → `MISSING_CREDENTIAL`;现经 `dshProcessEnv()` 从 `~/.dsh/.credentials.yaml` 补齐,主控与引擎检查均通过 |

桌面会话端到端(Codex Desktop,已打通):见上「核心机制速览」第 3、4 条;bus 端会话连接 `Codex Desktop 接入·01a1f517…`(session=桌面线程号)已落库,control_status 经插件 MCP 真实返回。

协议层端到端复验(2026-11-20 15:06,WebStorm `dev` 起真实总线 :62048):用桌面插件 `.mcp.json` 的真实凭据 spawn `cli.mjs mcp` 连接 `work/dev/bus.sock`,MCP 初始化成功(`agent-team-control 0.5.0`)、`tools/list` 返回 19 个工具、`control_status` 返回 `isError:false`。调用进程无 `CODEX_THREAD_ID`,因此走的是回落语义:激活凭据 + 无线程身份 → 回落到最近绑定的会话连接(`Codex Desktop 接入·31bd464d…`)。同一次复验中 DSH 在 dev 数据目录由 `unavailable`(修复前)翻为 `available`。

DSH 桌面接入(2026-11-20 16:13,已打通):手动桥接配置写入 `cordis.patch.yml` 并**彻底重启**(含 helper)后,`control_protocol` 返回 `compatible`(client/server 均 1),binding `DSH Desktop 接入·31bd464d…` status=active,能力清单含 `session.deliver`/`session.wake`/`turn.observe`,workspaceRoots=`/Users/zhoujunxiang`。唤醒是否真可用以 `control_wake_test` 结果为准(已知 headless resume 不可用)。

验收过程揪出的 5 个真 bug(全部已修+回归测试):验证策略挂载错位(.verify vs 顶层)、spawnTracked 未 ignore stdin、Claude 引擎候选根目录传错、DSH 失败结论被吞、CLI bind-session 忽略 --socket。**另有一个教训**:桌面会话的模型把 SKILL.md 编辑器草稿写进了仓库源文件 `skills/agent-team/SKILL.md`(connect-cli 进程测试当场抓住,已从 git 恢复)——桌面会话给了完全访问,模型会在仓库里动文件。

## 剩余工作(按优先级)

1. ~~**插件安装固化**~~:✅ 2026-11-20 完成(commit `82a62b5`)。插件目录 + `.mcp.json`(enabled/审批策略)+ `.codex-marketplace-install.json` + config.toml plugins 行自动写入,受管块保留;真实 config.toml 幂等、临时安装产物已验证。
1b. ~~**标准用户路径无需 CLI**~~:✅ 2026-11-20(commit `e2f9082`)——Skill 指引模型在会话内自行 `bind-session`(从插件 `.mcp.json` 推导 cli/socket/client/key),用户不碰终端;桌面侧 Skill 已同步。**真机验证(16:44)**:模型在 Codex 会话内自动完成绑定、建团(`CLI Free`)、派单,用户全程未执行终端命令,成员回 `OK`。
2. ~~**隐藏成员执行**~~:✅ 2026-11-20 真机通过——注册通道(commit `6e9a306`)、隔离目录与登录态(commit `b848317`)完成后,`成员=codex-desktop` 建团派单,成员在隔离 CODEX_HOME 里执行并回传 `OK`(消息链完整:主控发任务 → 成员 7 秒后回复),用户 `~/.codex` 无新会话。首次运行曾出现一次回合 completed 但无回传(隔离目录/auth 刚建立),重试稳定通过;app-server 事件经探测与 CLI 一致(`item/completed:agentMessage` 带 `threadId`),此前的「事件类型差异」猜测已排除。
3. **生命周期矩阵**(逐应用/版本记录):窗口关闭 vs 隐藏 vs 完全退出下,内嵌引擎可用性;应用升级/移除后的重验证与数据保留。
4. ~~**DSH 凭据通道**~~:✅ 验证路径与唤醒路径的凭据注入已修(commits `fc169f9`/`2c76d9a`);**唤醒桥已定级:不可用**——headless profile 与 desktop profile 的会话存储不共享,`--session-id` 直接报 `session "..." does not exist`(2026-11-20 实测),DSH 保持 Pull-only。成员回合真机已通过;`control_wake_test` 实测返回 `wake.state=degraded`、`receipt.state=failed`,reason 与底层一致,控制面自动降级行为正确。
5. ~~**两会话隔离 + 接管端到端**~~:✅ 2026-11-20 控制面层完成——真实 dev 总线 + 两个带线程身份的 MCP 客户端验证:独立会话连接、B 默认不可见、越权被拒、精确 ID 接管成功、A 只读保留。回落语义(无线程身份→最近绑定)仍是已知限制;GUI 桌面会话层未覆盖(需用户开两个真实窗口)。
6. **Phase 6 延后项**:建群确认摘要(会话侧,Skill 文案)、接管与 workspace 变更通知(团队视图)、主控关系视图。
7. **Phase 7 适配层收敛**:三切片落地后的抽象合并(桌面检测/验证代码与 hosts 的重复部分)。
8. **验收矩阵对照**:计划 §7 的 A-H 场景逐行补真宿主证据;§8 发布门逐条过。

## 验收矩阵证据状态(计划 §7,2026-11-20)

| 场景 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| A 单产品桌面使用 | 部分 | 接入+验证+激活+**桌面引擎成员在隔离目录执行并回传**(15:41)已实测;重开主控会话收结果待人工 |
| B 跨产品团队 | ✅(控制面) | 2026-11-20 15:47 三成员团队:claude/dsh 回传 `OK`;codex 因宿主长时间运行未回传,重启后单成员对照立即回 `OK`(见已知限制)。GUI 层未覆盖 |
| C 独立主控会话 | ✅(控制面) | 2026-11-20 15:10 真实 dev 总线 + 两个带线程身份的 MCP 客户端:独立连接、B 默认不可见、越权被拒;GUI 层未覆盖 |
| D 直接接管 | ✅(控制面) | 精确 ID 接管成功、A 只读保留;接管事件可见与前主控通知待 GUI 层 |
| E workspace 跟随 | 部分 | pending/结算/旧会话失效有契约测试;真机改目录待人工 |
| F 失败与修复 | 部分 | 卸载/引擎消失/指纹变化有契约测试;**DSH rc.3→rc.5 升级后重验通过**(14:52);真机破坏+恢复待人工 |
| G Pull-only | ✅ | Claude 实测 `pull-only`(wake.available=false),状态投影正确 |
| H 验证卫生 | ✅(今日) | 2026-11-20 15:52 核对:今日验证会话 0 条写入 `~/.codex`(隔离生效);仅 1 条 02:13 的历史验证会话残留 |

## 已知限制与风险

- 桌面聊天的 MCP 子进程无线程身份 → 并发桌面会话共享最近绑定(后绑定者赢);等宿主注入身份后收严。
- Codex Desktop 会重排 config.toml(受管块与 key 保留,实测 mtime 变化内容不丢)。
- 隔离 CODEX_HOME 对内嵌引擎有效、auth.json 符号链接可复用登录态——均为 26.1111.71704 单版本实测,升级需重验。
- 桌面会话有完全访问时会在仓库里动文件(实测改写 SKILL.md);给桌面会话的指令要明确边界。
- 前端 verify 的 HTTP 等待没有长轮询:真实验证超过 ~60s 时前端 fetch 超时,但后台验证继续并把结果落库,刷新状态可见(改进候选:轮询或 SSE)。
- 验证收尾会一次性删除隔离 CODEX_HOME(实测约 300 项:sqlite/cache/logs)。遇到带批量删除保护的环境(Agent 沙箱的 `safe-delete`、企业安全软件等)会被拦截,验证被误判失败。2026-11-20 在 WorkBuddy 沙箱内实测复现(`SAFE_DELETE_BULK_CONFIRM_REQUIRED`,阈值 50);去掉 shim 后三家均通过。改进候选:分批清理,或把隔离目录交给引擎侧自行清理。
- 桌面引擎成员宿主首次运行时,曾出现一次回合 completed 但消息未回传(当时隔离目录与 auth 链接刚建立);重试稳定通过。app-server 事件已探测与 CLI 一致,若复现优先查会话竞争/时序,不要再假设事件类型差异。
- **DSH 主动唤醒不可用**:headless profile 与 desktop profile 的会话存储不共享,`--session-id <桌面会话>` 报 `session "..." does not exist`(2026-11-20 实测)。`control_wake_test` 返回 `wake.state=degraded`、`receipt.state=failed`,控制面降级正确;2026-11-20 16:15 已在 DSH 会话接受 Pull-only(`state` 保持 `degraded` 属预期,表示可用但仅拉取),之后可正常建团/派单/用 `control_inbox` 领取。
- DSH 的 MCP 接入是手动桥接:配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml`,应用升级可能覆盖,需要重贴。2026-11-20 已写入 `mcp-agent-team` 条目(备份 `cordis.patch.yml.bak-*`)。**改完必须完全退出应用(含 helper 进程)再启动**——只关窗口或只杀主进程不会重新加载 MCP。
- 内置 codex 宿主曾出现「回合 completed 但回复不回传」(偶发,难稳定复现,重启服务即恢复;dsh/claude 不受影响)。2026-11-20 已加两处兜底(commit `59b1979`):事件 `threadId` 对不上且只有一个活跃回合时退回该回合;`item/completed` 缺失时用 `item/agentMessage/delta` 的流式累积兜底。**兜底未根除该问题**;同日又加诊断与 fail-loud(`0ddeae1`):记录本回合事件方法序列(限 200 条),文本为空时抛错并带序列——下次复现时 `turns.detail` 会直接指出是引擎没发 `item/completed`,还是上下文没接住。复现尝试(重启后连续 6 次派发)均正常,根因仍未定位。

## 生命周期矩阵(2026-11-20 首次记录)

窗口关闭/完全退出需要人工操作真实应用,不擅自执行;下表先记录可只读确认的部分,其余按步骤人工补。

| 应用 | 应用运行中 | 重启后 | 窗口关闭(进程存活) | 完全退出 | 升级后 |
| --- | --- | --- | --- | --- | --- |
| Codex Desktop | ✅ 验证通过 | ✅ 验证通过(14:51) | ✅ 通过(15:02,首轮偶发失败,复跑2次通过) | ✅ 退出后验证通过(14:55) | 待人工 |
| DSH Desktop | ✅ 验证通过 | ✅ 验证通过(14:52) | ✅ 通过(15:01) | ✅ 退出后验证通过(14:56) | ✅ rc.3→rc.5 升级后仍可用 |
| Claude Desktop | ✅ 验证通过 | ✅ 验证通过(14:52) | ✅ 通过(15:02) | ✅ 退出后验证通过(14:56) | 待人工 |

观测事实(2026-11-20 14:51–15:02):用户重启三家应用后均验证通过;逐个 `kill -TERM` 完全退出并在退出状态下复验——Codex、DSH(rc.5)、Claude 全部通过,说明内嵌引擎不依赖应用主进程的运行时服务(引擎是 bundle 内独立可执行文件)。随后用户手动关闭三家窗口、进程存活,再次复验全部通过(Codex 首轮主控检查偶发未返回版本,复跑两次通过)。每个应用验证后已 `open -a` 重新打开。至此窗口关闭、完全退出两类生命周期状态均已覆盖。

人工步骤(每步后跑一次面板验证,消耗少量额度):

1. 应用运行中 → 验证并记录(已完成);
2. 关闭窗口、进程仍存活 → 验证;
3. 完全退出应用 → 验证(判断引擎是否依赖应用进程的运行时服务);
4. 升级或重装应用 → 重新检测 + 验证,确认指纹变化触发重验、数据保留。

## 不可违背的产品边界(沿用,勿重开)

- 桌面应用是主控,不是成员;桌面宿主必须同时提供主控连接与可用内嵌引擎才算可用。
- 成员执行走框架私有隐藏会话,绝不写用户可见聊天历史;失败不静默换引擎/模型。
- 安装≠激活:桌面会话只有用户调 Skill/明确要求 Agent Team 工作时才激活。
- 多个主控会话互相看不到对方的团队(列表按关系收口);凭精确 team ID 可检视+接管;接管后旧会话只读保留关系。
- 团队 workspace 跟随主控会话 cwd;运行中回合 → pending,结算后才生效并失效旧目录会话。
- 永久删除只在第一方面板;Active wake 永不拉起已关闭的应用。
- 验证与成员会话不得出现在宿主正常聊天列表;验证产物只落框架私有目录并在所有结束路径清理。
- 本地单用户:精确 team ID + 显式接管即可,无需二次确认。

## 已核实事实(2026-11 实测,升级需重验)

- Codex Desktop `/Applications/ChatGPT.app`(26.1111.71704),内嵌引擎 `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`(0.169.1);桌面 app-server 启动参数带 `-c features.code_mode_host=true` 与捆绑插件开关;桌面聊天 MCP 走插件机制(见上)。
- DSH Desktop `/Applications/DeepSeek Harness.app`(0.2.2-rc.3),引擎 `Contents/Resources/runtime/cli/bin/dsh`;`headless --patch <overlay> --json <prompt>` 是非交互通道;凭据经私有凭据服务(不在明文);MCP 子进程无 DSH_SESSION_ID。
- Claude Desktop `/Applications/Claude.app`(6.6395.1),内嵌引擎不在 bundle,运行时下载到 `~/Library/Application Support/Claude-3p/claude-code/<版本>/<hash>/claude.app/Contents/MacOS/claude`;`claude -p --strict-mcp-config --mcp-config <file>` 可驱动 MCP 检查;桌面 MCP 子进程无 CLAUDE_SESSION_ID。
- 桌面 shell 环境注入 CODEX_THREAD_ID(与 MCP 子进程不同),bind-session 流程依赖它。

## 测试与安全规则

- `npm run check` + `npm test` 提交前必须全绿;自动化测试全部 fake 宿主(参照 `src/tests/contract/desktop-*.test.mjs`、`src/tests/process/desktop-verify.test.mjs` 的 fake bundle/引擎写法)。
- 真实验证消耗模型额度,先获用户确认;本机已获得过一次总授权(2026-11-20),但每轮新验收仍应先说明要做什么。
- 隔离临时目录与数据目录;改宿主配置前自动备份(config.toml/claude_desktop_config.json 的安装器已内置);不要打印凭据(插件 .mcp.json、config 受管块里都有 key,输出时打码)。
- 不要在 coordinating 工作的会话上测 wake;桌面会话有完全访问权限,给它指令时写清边界(教训见上)。
- `work/` 用户运行数据不得清理或改动;dev 总线的 work/dev 里有验收产生的真实 binding/桌面应用注册行,属于正常产品数据。

## 环境残留(接手时盘点,均为正常产品状态或可回退)

- dev 服务(`npm run dev`/IDE 配置)在 62048/5173,数据目录 `work/dev`;设置页面板即连它。
- `~/.codex/config.toml`:受管块(01:50 写入)+ `[plugins."agent-team@agent-team"]` 行;备份若干(`config.toml.agent-team-backup-*`)。回退:删受管块与插件行。
- `~/.codex/plugins/cache/agent-team/agent-team/0.5.0/`:验收手装的插件目录。回退:删除目录 + config 行。
- `~/Library/Application Support/Claude/claude_desktop_config.json`:agent_team 键已写入,备份 `*.agent-team-backup-*`。
- bus 库(work/dev)里有验收产生的 binding(三个激活连接、若干 verify 临时连接已禁用、一个已绑定的桌面会话连接)——正常产品数据,不清。
- 本文档与本轮记忆(`~/.zcode/cli/memories/.../desktop-integration-phase1.md`)为本地工件,不入库;`docs/adr/**` 是 docs 忽略规则的例外,已入库。
