# Member-level git worktree isolation

Status: accepted

## Context

当同一个 Git 仓库里的多个写作者（`workspace-write`）并发承担研发任务时，如果共用同一个 `group.workspace`，彼此的未提交文件修改、`git status` 与构建产物会互相覆盖，导致回归失败且难以归因。与此同时，主 Agent（`lead`）与协调会话、以及非 Git 目录中的既有协作团队不能被强制捆绑到 `git worktree`。

## Decision

1. **按普通成员按需启用，数据目录集中托管**：`members` 增加 `workspace_mode ('inherit' | 'worktree')`、`worktree_path`、`worktree_branch`（`SCHEMA_VERSION` 26 → 27）。受管 worktree 统一创建在框架数据目录下的 `<dataDir>/worktrees/<groupId>/<memberId>`，分支固定为 ASCII 安全名称 `agent-team/<groupShort8>-<memberSlug>-<memberShort4>`；禁止建在用户源码目录树内部（避免污染或被 `vitest`/`tsc`/`eslint` 扫描）。主 Agent、外部主控与 `communication` 成员禁止启用 `worktree`。
2. **强前置校验，绝不静默回退共享主目录**：申请 `worktree` 时同步校验目标工作区必须是 Git 仓库根目录（`realpath(workspace) === realpath(toplevel)`）、具备有效 `HEAD` 提交、且无 `index.lock`/未结束合并状态；多成员建树任一步失败即原子回滚本次已建目录与分支。成员回合启动前再次验证 `worktree_path` 仍存在且有效，缺失即报错阻断，绝不悄悄落回 `group.workspace` 执行。
3. **沙箱边界仅向受管 worktree 放行 `.git` 元数据目录（`commonDir` 与 linked `gitDir`）**：Git worktree 需要读写主仓库 `.git` 中的 `objects`/`refs` 及对应 `<repo>/.git/worktrees/<name>` 索引与锁文件；实测 macOS Codex Seatbelt 仅放行 `commonDir` 时仍会把 `.git/worktrees/<name>` 判为只读。受限沙箱（Codex `workspaceWrite` / Claude `filesystem.allowWrite`）通过 `worktreeGitWritableRoots` 为 worktree 成员同时放行 `<gitCommonDir>` 与 `<gitDir>`，但**绝不**把 `<group.workspace>` 主工作树纳入可写根目录，确保各写作者源码彻底隔离。
4. **保守销毁，绝不误删未合并代码**：移除成员或删除团队时逐一核对 worktree 状态：仅当工作树干净且相对基线无未合并新提交（`aheadCount === 0`）时自动执行 `git worktree remove` 并删分支；只要存在未提交改动或未合并提交，就保留目录与分支并明示路径与分支名。合并回主分支仅提供人工显式触发的受保护入口（要求主工作区干净，冲突立即 `git merge --abort`）。

## Considered options

- **把 worktree 建在 `<workspace>/.agent-team/worktrees/` 内**：拒绝。测试框架、TypeScript、linter 与搜索工具默认递归扫描源码仓库，会在主目录内重复扫入成员副本。
- **非 Git 目录或工作树缺失时回退共享 `group.workspace`**：拒绝。用户已请求隔离，静默回退共享目录会导致并发互相覆写且用户无感知。
- **删群或移除成员时强制 `git worktree remove --force`**：拒绝。会悄无声息销毁成员尚未合并的分支与代码。

## Consequences

- `worktree` 状态与分支清理只由框架明确接口和人工显式触发，不改变 `open` / `archived` 两态模型，也不自动对用户主工作区执行 `git merge`。
- `src/hosts/worktree.mjs` 全程使用 `git` 子进程参数数组调用（无 shell 拼接）保证三平台中性；细节规格见 `docs/flows/2026-11-23-dev-workflow-and-worktrees/spec.md`。
