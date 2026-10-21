# 宿主权限隔离验证记录

日期：2026-10-21
范围：验证“仅沟通”工具裁剪及可写会话恢复为只读的实际效果。本记录保留为宿主配置能力证据；产品适配与端到端协作验收见[实施与验收](./collaboration-implementation-plan.md)。

## 1. 结论

| 宿主 | 仅沟通 | 可写恢复为只读 | 本轮结论 |
| --- | --- | --- | --- |
| Claude Code 2.1.215 | 空内置工具集合，仅保留测试汇报 MCP，实际汇报成功 | 同一会话恢复后移除写入和命令工具，旧 Write调用被宿主拒绝 | 测试配置下通过；依赖工具集合与权限规则，不等同于整进程隔离 |
| DSH 0.2.0-rc.2 | 在 Agent scope使用 tools.restrict，仅保留测试汇报工具，实际汇报成功 | 只改默认值无效；显式更新会话模式后文件和脚本写入均被拒绝 | 有可用接入方式，必须处理持久会话权限 |
| Codex CLI 0.158.0 app-server | 原始只读配置不满足；补测关闭命令及其他执行能力后，两个新会话均仅调用测试沟通工具，未发生文件操作 | 已加载线程的resume传read-only仍返回workspaceWrite；turn/start显式sandboxPolicy后实际拒绝写入 | 已找到本轮仅沟通配置的可用路径；不是全部潜在调用路径的安全证明 |

以上是有限执行路径的验证结果，不是所有工具、插件、MCP或子进程均不可绕过的证明。

## 2. 测试环境及证据

测试根目录为 `/tmp/agent-team-permissions-QrvpWI`，每个宿主使用独立测试目录和专用会话。每个目录包含读取标记文件、可写目标文件及可能被创建的测试文件。

使用真实本机宿主及其现有登录凭据进行推理。未创建Agent Team群，未接入当前团队，未修改用户全局配置或项目源码。宿主仍会保存自己的专用测试会话；临时启动配置和测试插件均独立创建。

测试汇报工具 probe_report只记录实验结果，不连接真实团队。它验证工具调用可以继续工作，不代表已经验证send/read等完整团队集成。

长期证据归档在 `work/permission-validation-20261021`：

- `summary.json`：14个正式测试阶段的摘要、会话编号及文件快照。
- `claude/`、`dsh-clean/`、`codex/`、`codex-followup/`、`codex-confirm/`：原始宿主事件、错误输出和各阶段结果。
- `codex-native-tool-evidence.jsonl`：从专用Codex原始会话提取的工具调用、结果及回合上下文。
- `probe.mjs`、`mcp.mjs`、`dsh-plugin.mjs`：实验程序，保留实验绝对路径；不是产品实现。
- `manifest.json`：归档文件SHA-256。

初期修正过实验程序：Claude变长参数吞掉prompt，DSH错误地使用全局tool restriction，以及权限preset未匹配配置。这些启动失败不计入能力结论，正式结果以修正后的Claude和dsh-clean目录为准。

DSH实验中的policies.jsonl初版观察器错误地将session对象直接传给resolve，而不是传 `{session}`，因此其中before/after字段只反映默认策略，不能作为会话实际权限的证据。观察器源码已修正；本报告的恢复结论依据实际文件工具和shell调用结果、文件快照及原始宿主事件，不使用该错误观察值。

## 3. Claude结果

### 仅沟通

使用空内置工具集合、strict-mcp-config、dontAsk，仅预允许 `mcp__permission_probe__probe_report`。

system/init的工具集合仅包含该测试MCP工具，模型成功调用汇报工具。文件读取和shell未暴露，测试文件保持原样。

依据：`claude/communication.jsonl`、`communication.summary.json`和`reports.jsonl`。

### 恢复为只读

先创建Read/Write可用的专用会话，实际将target.txt写为WRITABLE_OK。恢复同一session时，预允许Read，并通过disallowedTools移除Write、Edit、Bash。

恢复后Read实际成功；模型仍因旧上下文尝试Write，宿主返回：

```text
No such tool available: Write. Write exists but is not enabled in this context.
```

target.txt保留WRITABLE_OK，created.txt不存在。Bash没有暴露，因此不是shell写入到达文件系统后被拒绝，而是命令工具不可用。

另用新会话仅开放Read/Glob/Grep，实际读取成功，文件和命令修改工具均未暴露。

依据：`claude/writable.summary.json`、`resumed-readonly.jsonl`及`read-tools-only.summary.json`。

读写测试阶段未预允许测试汇报MCP，模型额外尝试该工具时被dontAsk拒绝。这不影响读写结果，但产品配置应显式允许所需沟通工具，不能只选择内置文件工具后遗漏团队MCP权限。

## 4. DSH结果

使用临时patch将session及storage输出指向测试目录，统一approval为never，并配置匹配的permission preset。通过临时测试插件调用已安装宿主公开机制，不修改用户profile。

### 仅沟通

测试插件在agent/created、首轮输入之前，对agent.ctx.tools应用 `restrict({allow:['probe_report']})`。

模型只调用probe_report，汇报成功；没有文件或shell工具调用，项目文件保持原样。该方法依赖宿主Agent scope的工具机制，不能用全局context调用restrict。

依据：`dsh-clean/communication.jsonl`和`reports.jsonl`。

### 默认值不会覆盖持久会话

可写阶段实际成功覆盖target.txt。恢复同一session时，仅将sandbox-policy和preset的启动默认值改为read-only，文件write和node脚本均仍成功：target.txt变为BLOCKED_WRITE，created.txt被创建。

这证明仅修改新启动进程默认值，不足以收紧已有会话。

### 显式更新会话后生效

再次恢复同一session，在首轮输入前通过宿主setSandboxMode将该session改为read-only，同时设置approval为never。

实际write调用返回 `[sandbox: file access denied under read-only mode]`；bash中的node写文件返回EPERM，文件快照保持前一阶段内容。

由于目标内容与前一阶段相同，文件快照本身不能证明本阶段拒绝；拒绝依据是原始write错误、shell的EPERM及非零退出状态。文件结果用于交叉核对。

依据：`dsh-clean/resumed-default-readonly.jsonl`、`resumed-forced-readonly.jsonl`及对应summary。

## 5. Codex结果

### read-only不等于仅沟通

通过app-server创建read-only线程，仅注册probe_report动态工具。实际执行了 `cat read.txt; pwd`，读取和shell均成功，之后调用probe_report成功。

这组参数不能构成仅沟通模式。结果不代表Codex一定无法做到仅沟通，正确的原生工具裁剪配置仍未验证。

### 已加载线程的resume不能直接当作权限切换成功

可写线程中实际写入target.txt成功。同一app-server进程内对已加载线程调用thread/resume并传入read-only，响应仍是workspaceWrite；随后的node写文件实际成功。

第二次对照在另一个专用app-server进程里恢复同一测试线程：先通过turn/start显式workspaceWrite写入toggle.txt为CONTROL，再对已加载线程resume请求read-only，响应依然为workspaceWrite。此现象只描述本机版本、当前请求与已加载线程场景，不推断所有resume调用都忽略策略。

依据：`codex/resumed-thread.json`、`resumed-readonly.summary.json`、`codex-confirm/same-process-resume.json`。

### 显式回合策略实际拒绝写入

接着在同一进程、同一线程中通过turn/start传入 `sandboxPolicy: {type:'readOnly',networkAccess:false}`，请求node将toggle.txt改为TURN_PROBE。

原始工具结果显示退出1及EPERM；toggle.txt仍为CONTROL。此前另一次显式只读回合也拒绝了新建turn-readonly.txt，文件没有生成。

因此后续Adapter可以研究按回合显式指定策略，但必须检查真实返回和执行结果，不能只因resume请求参数包含read-only就登记成功。

### 执行限制与实时观测分开验收

显式只读写入拒绝在专用原始会话里保存了exec_command调用和function_call_output；本次读取的实时app-server item/completed中没有对应commandExecution完成项。

因此仅采集当前实时事件可能漏掉这类拒绝；原始会话证据证明操作确实执行并被拒绝。尚未定位事件缺失的完整原因，不据此宣布宿主事件流本身有缺陷。

此外，默认配置加载了用户已有MCP集成，模型曾尝试WebStorm apply_patch，均因approvalPolicy为never被宿主拒绝；实际可写基线最终由本地命令完成。测试提示虽限制了路径，仍不能将本实验称为完全裁剪所有外部集成的环境。

依据：`codex-native-tool-evidence.jsonl`、`codex-confirm/protocol.stderr`中的Seatbelt违规记录、`codex-confirm/actual-file.json`及原始protocol。

## 6. 对实施的直接影响

1. Claude可优先采用内置工具集合加必要团队MCP的方式实现仅沟通和项目只读，恢复时重新明确工具权限。
2. DSH可使用Agent scope工具裁剪；恢复时须显式更新session策略，不能只配置默认值。
3. Codex只读需优先接入turn/start的实际策略；仅沟通已有补测通过的功能裁剪配置，具体见第 7 节，不能使用被忽略的enabled_tools字段。
4. 记录请求配置和实际生效结果；发现不一致时报告，不把配置意图等同于执行事实。
5. 通知与限制验证分开：工具被拒绝可能没有出现在当前实时观察路径，不能只依赖Agent最终自述。

尚未验收：全部团队工具集成、网络与外部发送限制、框架真实数据目录隔离、全部插件与子Agent路径、每个宿主所有模型及版本组合。

本轮14个正式阶段已结束，实验驱动及测试汇报进程已退出。保留测试文件、日志和专用会话供复核；没有自动回滚或删除证据，也没有修改现有团队数据库。

## 7. Codex仅沟通补测

本节补充同日后续测试。归档新增 `codex-communication/`、`codex-feature-mask/`和`codex-feature-mask-clean/`三个有实际模型回合的实验，共计17个正式阶段。产品代码仍未修改。

### 7.1 排除无效白名单

尝试通过线程配置传enabled_tools和tool_registry时，本机0.158.0明确发出configWarning：两个字段被忽略。随后模型实际读取read.txt并运行pwd，证明该配置不能作为仅沟通白名单。

这再次说明字段存在于二进制字符串或请求被接受，不代表配置有效。

### 7.2 功能裁剪配置及干净复测

改用宿主功能开关关闭shell_tool、unified_exec、apps、plugins、multi_agent、js_repl、code_mode、code_mode_host、browser_use、browser_use_external、computer_use、in_app_browser、image_generation、view_image、skill_search和workspace_dependencies；关闭web_search；禁用本机实际配置的idea、webstorm、shadcn及node_repl MCP。继续注册测试动态沟通工具probe_report，并使用read-only、approvalPolicy=never。

这是一组测试通过的配置组合，不声称每个开关都是必要条件或已经得到最小配置。后续产品适配应根据实际宿主配置枚举额外工具来源，不能把本机四个MCP名称硬编码为通用保证。

第一轮功能裁剪中额外传入tools.view_image，本机提示该字段被忽略；保留受支持的features.view_image，并移除冗余字段后再次创建新会话。最终干净配置没有新增的session-flags忽略警告；既有用户配置中的mcp_servers.idea.type警告仍存在，本轮不修改用户配置。

两次功能裁剪实验中，模型均报告没有原生文件、命令或修改工具，实际只调用probe_report并成功收到结果。原始事件无commandExecution、文件修改或外部MCP调用；读取标记未通过工具读出，target.txt保留UNCHANGED。

本轮验证的是宿主向模型暴露的执行工具已收窄并保留沟通能力，没有人为构造已移除工具调用去验证所有底层拒绝路径，也不把“文件未变”单独当作强制隔离证明。

最后干净配置、会话结果和报告调用依据：`codex-feature-mask-clean/requested-config.json`、`thread.json`、`result.json`、`reports.jsonl`及`protocol.jsonl`。

### 7.3 当前可作出的判断

Codex仅沟通已有本机版本下可复现的配置路径，Claude和DSH的先前核心验证结论保持不变。三个宿主的核心策略均已形成实验依据；产品适配器的通信与允许修改路径已在真实三宿主协作验收中实际运行，文件只读路径继续引用本记录中的宿主拒绝和恢复证据。

新会话裁剪通过不代表同一已加载会话中可以随时修改所有功能开关。若后续要求在现有调度会话上切换工具集合，必须另行验证恢复或重建语义，不能据本节推断即时生效。

配置开关参考：[OpenAI官方配置说明](https://developers.openai.com/codex/config-reference)。实际是否接受及行为以本机原始警告和回合证据为准，在线文档与本机存在字段差异。

## 8. 产品策略域复测

产品适配器采用两个 Codex 策略域后，真实 `Bus` 验收得到两个不同 thread：沟通 thread和项目 thread。沟通 thread 只回复团队消息；项目 thread 中，`read-only` 写入返回 `operation not permitted`，同一 thread切到 `workspace-write` 后写入成功；再次进入沟通域时复用原沟通 thread。

同 session 探针同时确认 Claude 和 DSH 可在同一 session 内依次切换 `communication → read-only → workspace-write`。Codex 的已加载 thread 不重新应用完整工具配置；`resume`、`unsubscribe`、`fork` 和进程重启都不是可靠的在线工具切换方式，因此产品以策略域 thread 绑定规避。
