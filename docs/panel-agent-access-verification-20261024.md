# Panel Agent 三档权限验证记录

日期：2026-10-24（Asia/Shanghai）
状态：真实宿主验证与产品级集成冒烟完成；产品适配器已实现（2026-10-24）
范围：Panel Agent 私人会话的用户级 `read-only` / `workspace-write` / `full-access` 三档权限，以及 Codex、Claude、DSH 三个宿主的等价映射。
证据：[`work/panel-access-verify-20261024/`](../work/panel-access-verify-20261024/REPORT.md)

## 1. 结论

三档权限在 Codex 0.158.0、Claude 2.1.215、DSH 0.2.0-rc.2 上都能被表达并实际执行。判定以临时目录中的实际文件状态、原始宿主事件/错误与配置观测交叉核对，不采信模型自述。

| 宿主 | read-only | workspace-write | full-access |
| --- | --- | --- | --- |
| Codex 0.158.0 | PASS | PASS | PASS |
| Claude 2.1.215 | PASS | PASS（必须加路径规则） | PASS |
| DSH 0.2.0-rc.2 | PASS | PASS | PASS |

每档要求同时满足：

- 三档都能读工作区内的 sentinel；
- `read-only`：工作区内、工作区外、临时目录的写入都被拒绝；
- `workspace-write`：工作区内读写与 shell 写入成功，工作区外写入与 shell 写入被拒绝；
- `full-access`：工作区内外的文件写入与 shell 写入都成功。

`full-access` 只表示关闭文件沙箱；网络与进程可见性不在该策略词汇内，不承诺网络隔离。

## 2. 宿主等价映射

### 2.1 Codex 0.158.0

协议层三档均被接受：`thread/start` 的 `sandbox` 接受 `read-only` / `workspace-write` / `danger-full-access`；`turn/start` 的 `sandboxPolicy` 接受 `readOnly` / `workspaceWrite` / `dangerFullAccess`。`dangerFullAccess` 与 `readOnly`、`workspaceWrite` 一样在回合中实际生效。

| 档位 | `thread/start` sandbox | `turn/start` sandboxPolicy | 关键配置 |
| --- | --- | --- | --- |
| read-only | `read-only` | `{type:'readOnly',networkAccess:false}` | `features.shell_tool:true`、`features.unified_exec:true`，其余功能关闭，`approvalPolicy:'never'` |
| workspace-write | `workspace-write` | `{type:'workspaceWrite',writableRoots:[workspace],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}` | 同上 |
| full-access | `danger-full-access` | `{type:'dangerFullAccess'}` | 同上 |

实测：

- read-only：`apply_patch` 写入被明确拒绝（`writing is blocked by read-only sandbox`），shell 写工作区内/外均被拒绝，文件保持原状。
- workspace-write：`apply_patch` 写工作区内成功；shell 写工作区内成功；写工作区外被明确拒绝（`writing outside of the project`）。
- full-access：`apply_patch` 与 shell 对工作区内外写入都成功。
- 探针中模型的 `apply_patch` / `exec_command` 通过 `functions.exec` 包装调用；实际命令与文件变更均出现在原始事件中。产品适配器当前已启用相同 features，具体工具入口由宿主暴露方式决定。

### 2.2 Claude 2.1.215

Claude 的 Bash 沙箱与 Write/Edit 工具是两套机制：**Write/Edit 不受 Bash 沙箱约束**，因此 `workspace-write` 必须用权限路径规则约束文件工具，不能只依赖 sandbox。

| 档位 | `--tools` | `--allowedTools` | `--settings` sandbox |
| --- | --- | --- | --- |
| read-only | `Read,Glob,Grep,Bash` | `Read,Glob,Grep,Bash` | `{enabled:true,allowUnsandboxedCommands:false,failIfUnavailable:true,filesystem:{denyWrite:[workspace]}}` |
| workspace-write | `Read,Glob,Grep,Edit,Write,Bash` | `Read,Glob,Grep,Bash,Edit(**),Write(**)` | `{enabled:true,allowUnsandboxedCommands:false,failIfUnavailable:true}` |
| full-access | `Read,Glob,Grep,Edit,Write,Bash` | `Read,Glob,Grep,Edit,Write,Bash` | 不设置（关闭沙箱） |

共同条件：`--permission-mode dontAsk`、cwd＝`workspace`、`--strict-mcp-config`，团队 MCP 工具单独追加到 `--allowedTools`。

实测：

- read-only：Read 与 Bash 读命令成功；Bash 写工作区内、工作区外、`/tmp` 都被拒绝；Write/Edit 未暴露。
- workspace-write：Write/Edit 写工作区内及嵌套子目录成功；写工作区外、相邻目录被权限规则拒绝；Bash 写工作区内成功、工作区外被沙箱拒绝。**对照组**：`--allowedTools` 只写 plain 工具名时，Write 工具能绕过沙箱直接写工作区外，证明路径规则是必需的。
- full-access：Write 与 Bash 对工作区内外写入都成功。
- 同一 session 通过 `--resume` 从 full-access 降到 read-only、从 read-only 升到 full-access 都实际生效（工具集合与沙箱随每次调用重新应用）。

### 2.3 DSH 0.2.0-rc.2

`@deepseek-ai/dsh-sandbox-policy` 的 `SANDBOX_MODES` 为 `read-only`、`workspace-write`、`danger-full-access`；`danger-full-access` 表示绕过文件限制。`sandbox-policy.config.mode` 与 `permission.presets.*.sandbox` 都接受 `danger-full-access`；拼错为 `full-access` 会触发 schema 拒绝（负向对照已验证）。

| 档位 | sandbox-policy mode | permission preset sandbox | 工具 |
| --- | --- | --- | --- |
| read-only | `read-only` | `read-only` | 读文件工具 + write/edit + bash（写操作由沙箱拒绝） |
| workspace-write | `workspace-write` | `workspace-write` | 同上，工作区内可写 |
| full-access | `danger-full-access` | `danger-full-access` | 同上，无文件边界 |

共同条件：`approval.policy:'never'`、session cwd＝`workspace`、`workspaceRoot` 指向工作区。

实测：

- read-only：read 成功；write 被拒绝（`[sandbox: file access denied under read-only mode]`）；bash 写工作区内/外都返回 `Operation not permitted`。
- workspace-write：write 与 bash 写工作区内成功，工作区外被拒绝。
- full-access：write 与 bash 写工作区内外都成功。
- **恢复 session 的坑**：恢复已有 session 时只改 patch 默认 mode 不会生效；必须在 `agent/created` 显式 `setSandboxMode`（或等价写入 `sandbox/mode` 事件）才切换档位。产品 `src/hosts/dsh-policy.mjs` 已在每次调用追加 `sandbox/mode`，实现时必须把新的档位传进去。
- 无效插件 config 可能只产生 stderr warning 并跳过条目，进程仍 exit 0；验收必须检查实际策略观测或文件结果，不能只看退出码。

## 3. 会话切换结论

| 宿主 | 档位切换 | 设计处理 |
| --- | --- | --- |
| Claude | 同一 session `--resume` 可升/降档，实际生效 | 可复用；产品仍按统一策略在档位变化时重建私人会话，降低宿主差异风险 |
| DSH | 恢复 session 必须显式设置 sandbox mode | 产品插件每次调用显式设置；同时统一重建私人会话 |
| Codex | `turn/start` 可显式指定 sandboxPolicy；`thread/start` 的 sandbox 在恢复时不一定重新应用 | 统一重建私人会话，避免依赖恢复语义 |

统一规则：`host`、`model`、`workspace`、`access` 任一变化都只重建**私人会话**，保留私人聊天记录与 coordination 会话；`name` 变化不重建。

## 4. 已知限制

1. 文件/命令可达后，Panel Agent 在 OS 用户权限内可以读到框架数据目录与其他宿主的 session 文件。旧设计“不能查看成员私人会话”在文件系统层不再可强制，这是能力升级的已知代价。
2. `read-only` 不是整机只读：Claude/DSH 宿主自身的 state/temp 目录、host sandbox 允许的路径仍可能有写入；本次验证覆盖工作区、工作区外普通目录和 `/tmp`。
3. `full-access` 不等于网络隔离；网络与进程可见性不在三档词汇内。
4. Claude 的文件工具必须靠权限路径规则收窄；只写 plain `--allowedTools` 会绕过沙箱，后续实现必须用测试锁定这个映射。
5. 本验证使用隔离的 `CODEX_HOME` / `DSH_HOME`，Credential 只读软链，未修改用户 profile；宿主升级后必须重跑。
6. 运行时外层沙箱会制造假阴性：外层 workspace-write seatbelt 会让 Codex/DSH 的 `sandbox-exec` 失败，也会让 Claude 的 `session-env` 创建 EPERM。本记录结论来自未嵌套沙箱的复跑。
7. 验证 `workspace-write` 的“工作区外”目标不能放在宿主临时目录（如 `/tmp`、`/var/folders`），因为该档位允许写宿主临时区；应使用普通项目目录之外的路径。

## 5. 证据索引

- 总索引：[work/panel-access-verify-20261024/REPORT.md](../work/panel-access-verify-20261024/REPORT.md)
- Codex：`work/panel-access-verify-20261024/codex/{read-only,workspace-write,full-access}/summary.json` 与 `protocol.jsonl`
- Claude：`work/panel-access-verify-20261024/claude/`
  - 候选映射与判定：`ro-bash-deny-workspace/`、`ro-bash-read-control/`、`ro-bash-deny-abs/`、`rw-write-tools-rules/`、`rw-edit-rules/`、`rw-rules-nested/`、`rw-bash-only/`、`full-no-sandbox/`
  - 反例：`rw-write-tools-plain/`（Write 绕过沙箱）
  - 会话切换：`switch-full-to-ro/`、`switch-ro-to-full/`
- DSH：`work/panel-access-verify-20261024/dsh/{read-only,workspace-write,full-access}/{summary.json,stream.jsonl,policies.jsonl}`、`supplemental/`、`resume/`
- 复跑命令见证据索引第 3 节。

## 6. 产品级集成冒烟（实现后）

实现完成后通过 `startServer` + 真实宿主做面板级冒烟，验证 Bus → 适配器 → 宿主的现场行为（脚本与结果在 `work/panel-access-verify-20261024/`）：

| 宿主 | read-only 私人回合 | workspace-write 写工作区内 | workspace-write 写工作区外 | 观测到的策略 |
| --- | --- | --- | --- | --- |
| Codex 0.158.0 | PASS | PASS | 被拒（OS `operation not permitted`） | `turnSandbox` 为 `readOnly` / `workspaceWrite`，requested 含 access |
| Claude 2.1.215 | PASS | PASS | 被拒（Write 权限规则） | `allowedTools` 含 `Edit(**),Write(**)`；sandbox 按档位生成 |
| DSH 0.2.0-rc.2 | PASS | PASS | 被拒（`[sandbox: file access denied under workspace-write mode]`） | sessionPolicy 为 `workspace-write`；插件显式设置 mode |

- read-only 冒烟脚本：`product-smoke.mjs`，结果 `product-smoke-result.json`；三宿主 `framework.context` 记录配置的 workspace/access，`framework.policy.requested` 为 `{mode:'read-only',allowShell:true}`。
- workspace-write 冒烟脚本：`product-access-smoke.mjs`，结果 `product-access-smoke-result.json`；三宿主工作区内写入成功、工作区外写入被拒。
- 冒烟中发现并修复：`executionPolicy` 曾丢失 `access`，导致 Claude 的 workspace-write 退化为 plain Write 工具并成功写出工作区；修复后 `allowedTools` 包含路径规则，工作区外写入被拒，并在 `test/panel-access.test.mjs` 增加回归断言。
- 冒烟中的工作区外目标放在仓库 `work/` 下，而不是宿主临时目录，避免 workspace-write 的 temp 允许区掩盖边界。
