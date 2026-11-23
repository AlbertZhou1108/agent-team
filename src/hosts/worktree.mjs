/**
 * 成员级 Git Worktree 隔离管理器（专项 3）：
 * - 三平台中性：所有 git 命令一律通过 execFileSync 参数数组执行，绝不走 shell 拼接；
 * - 受管路径集中于 <dataDir>/worktrees/<groupId>/<memberId>，不污染用户源码目录树；
 * - 强前置校验 + 失败原子回滚，绝不在非 Git/无 HEAD/失效 worktree 时静默回退共享主目录；
 * - 保守销毁：只要含未提交改动或未合并新提交，删成员/删团队一律保留分支与工作树目录。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const WORKTREE_ROOT_DIR = 'worktrees';
const BLOCKING_REFS = Object.freeze([
  ['index.lock', 'Git 仓库存在未释放的 index.lock'],
  ['MERGE_HEAD', 'Git 仓库正在进行未完成的 merge'],
  ['REBASE_HEAD', 'Git 仓库正在进行未完成的 rebase'],
  ['CHERRY_PICK_HEAD', 'Git 仓库正在进行未完成的 cherry-pick'],
  ['REVERT_HEAD', 'Git 仓库正在进行未完成的 revert'],
]);

function safeRealpath(targetPath) {
  try {
    return realpathSync(resolve(targetPath));
  } catch {
    return resolve(targetPath);
  }
}

function runGit(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const detail = stderr || stdout || error?.message || 'git 命令执行失败';
    const wrapped = new Error(detail);
    wrapped.cause = error;
    throw wrapped;
  }
}

function gitRefExists(repoRoot, ref) {
  try {
    execFileSync('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', ref], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function sanitizeBranchSlug(name) {
  const ascii = String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return ascii || 'member';
}

export function worktreeDirectory(dataDir, groupId, memberId) {
  return join(resolve(dataDir), WORKTREE_ROOT_DIR, groupId, memberId);
}

export function normalizeWorkspaceMode(value) {
  if (value === undefined || value === null || value === '') return 'inherit';
  if (value !== 'inherit' && value !== 'worktree') throw new Error(`未知成员工作区模式: ${value}`);
  return value;
}

export function assertWorktreeMemberEligible(groupPolicy, person, workspaceMode) {
  if (workspaceMode !== 'worktree') return;
  if (person.role === 'lead') throw new Error('主 Agent 与协调席必须共享主工作区，不支持 worktree 隔离');
  if (groupPolicy === 'communication' || person.policyCeiling === 'communication') {
    throw new Error('仅沟通成员不读写工作区文件，不需要 worktree 隔离');
  }
}

/** 为拟创建的成员列表分配 ID 并按需构建 worktree，中途失败自动回滚已建工作树与分支。 */
export function provisionMemberWorktrees({ dataDir, groupId, workspace, groupPolicy, people, idFactory }) {
  const prepared = people.map(person => ({
    ...person,
    id: person.id ?? idFactory(),
    workspaceMode: normalizeWorkspaceMode(person.workspaceMode),
  }));
  for (const person of prepared) {
    assertWorktreeMemberEligible(groupPolicy, person, person.workspaceMode);
  }
  if (!prepared.some(person => person.workspaceMode === 'worktree')) {
    return {
      members: prepared.map(person => ({ ...person, worktreePath: null, worktreeBranch: null })),
      rollback: () => {},
    };
  }
  const repoInfo = inspectGitRepoForWorktree(workspace);
  const created = [];
  const reservedBranches = new Set();
  try {
    const members = prepared.map(person => {
      if (person.workspaceMode !== 'worktree') {
        return { ...person, worktreePath: null, worktreeBranch: null };
      }
      const wt = createMemberWorktree({
        dataDir,
        groupId,
        memberId: person.id,
        memberName: person.name,
        repoInfo,
        reservedBranches,
      });
      created.push(wt);
      return { ...person, worktreePath: wt.worktreePath, worktreeBranch: wt.worktreeBranch };
    });
    return {
      members,
      rollback: () => rollbackCreatedWorktrees(repoInfo.repoRoot, created),
    };
  } catch (error) {
    rollbackCreatedWorktrees(repoInfo.repoRoot, created);
    throw error;
  }
}

/** 校验目标目录可用于创建成员 worktree：必须是有效 Git 仓库根目录且具备 HEAD，无阻塞态。 */
export function inspectGitRepoForWorktree(workspace) {
  const resolved = resolve(workspace);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('启用 worktree 隔离要求团队工作区为有效的 Git 仓库根目录');
  }
  let topLevel;
  try {
    topLevel = runGit(resolved, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error('启用 worktree 隔离要求团队工作区为有效的 Git 仓库根目录');
  }
  const canonicalWorkspace = safeRealpath(resolved);
  const canonicalTopLevel = safeRealpath(topLevel);
  if (canonicalWorkspace !== canonicalTopLevel) {
    throw new Error('启用 worktree 隔离要求团队工作区为 Git 仓库根目录，不支持仅对子目录开启');
  }
  let headSha;
  try {
    headSha = runGit(canonicalTopLevel, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    throw new Error('当前 Git 仓库尚无初始提交（HEAD），请先完成至少一次 commit 再启用 worktree 隔离');
  }
  const rawCommonDir = runGit(canonicalTopLevel, ['rev-parse', '--git-common-dir']).trim();
  const gitCommonDir = safeRealpath(resolve(canonicalTopLevel, rawCommonDir));
  const rawGitDir = runGit(canonicalTopLevel, ['rev-parse', '--git-dir']).trim();
  const gitDir = safeRealpath(resolve(canonicalTopLevel, rawGitDir));
  for (const [marker, reason] of BLOCKING_REFS) {
    if (existsSync(join(gitCommonDir, marker)) || existsSync(join(gitDir, marker))) {
      throw new Error(`${reason}，请先处理后再启用 worktree 隔离`);
    }
  }
  let currentBranch = null;
  try {
    const branch = runGit(canonicalTopLevel, ['symbolic-ref', '--short', 'HEAD']).trim();
    if (branch) currentBranch = branch;
  } catch {
    currentBranch = null;
  }
  return { repoRoot: canonicalTopLevel, headSha, currentBranch, gitCommonDir };
}

function uniqueBranchName(repoRoot, groupId, memberId, memberName, reserved = new Set()) {
  const groupShort = groupId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'team';
  const memberShort = memberId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4) || 'm';
  const base = `agent-team/${groupShort}-${sanitizeBranchSlug(memberName)}-${memberShort}`;
  let candidate = base;
  let index = 2;
  while (reserved.has(candidate) || gitRefExists(repoRoot, `refs/heads/${candidate}`)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  reserved.add(candidate);
  return candidate;
}

/** 创建成员受管 worktree，并返回落库字段。 */
export function createMemberWorktree({ dataDir, groupId, memberId, memberName, repoInfo, reservedBranches }) {
  const branch = uniqueBranchName(repoInfo.repoRoot, groupId, memberId, memberName, reservedBranches);
  const worktreePath = worktreeDirectory(dataDir, groupId, memberId);
  if (existsSync(worktreePath)) {
    throw new Error(`目标 worktree 路径已存在，拒绝覆盖: ${worktreePath}`);
  }
  mkdirSync(dirname(worktreePath), { recursive: true });
  try {
    runGit(repoInfo.repoRoot, ['worktree', 'add', '-b', branch, worktreePath, repoInfo.headSha]);
  } catch (error) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* 清理失败不影响错误上抛 */ }
    throw new Error(`创建成员 ${memberName} 的 git worktree 失败: ${error.message}`, { cause: error });
  }
  return {
    worktreePath: safeRealpath(worktreePath),
    worktreeBranch: branch,
    baseCommit: repoInfo.headSha,
  };
}

/** 多成员创建中途失败时的原子回滚：只清理本次新建的干净 worktree 与分支。 */
export function rollbackCreatedWorktrees(repoRoot, createdList = []) {
  for (const item of [...createdList].reverse()) {
    if (!item?.worktreePath) continue;
    try {
      runGit(repoRoot, ['worktree', 'remove', '--force', item.worktreePath]);
    } catch {
      try { rmSync(item.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
      try { runGit(repoRoot, ['worktree', 'prune']); } catch { /* ignore */ }
    }
    if (item.worktreeBranch && gitRefExists(repoRoot, `refs/heads/${item.worktreeBranch}`)) {
      try { runGit(repoRoot, ['branch', '-D', item.worktreeBranch]); } catch { /* ignore */ }
    }
  }
}

/** 回合启动前强校验：受管 worktree 必须存在且仍是有效的 git 工作树，绝不回退主工作区。 */
export function assertWorktreeUsable(worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string' || !existsSync(worktreePath) || !statSync(worktreePath).isDirectory()) {
    throw new Error(`成员独立 worktree 不存在或已被删除（${worktreePath ?? '空路径'}），已阻止执行且不会回退共享主目录`);
  }
  try {
    const inside = runGit(worktreePath, ['rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') throw new Error('not a worktree');
  } catch {
    throw new Error(`成员独立 worktree 已损坏或非有效 Git 工作树（${worktreePath}），已阻止执行且不会回退共享主目录`);
  }
}

/**
 * 若工作区是 linked git worktree（.git 为指向 common-dir 的文件），返回对应的 .git common-dir。
 * 供宿主受限沙箱追加元数据可写根，绝不返回主工作区工作树。
 */
export function gitCommonDirForWorktree(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return null;
  const dotGit = join(worktreePath, '.git');
  try {
    if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return null;
    const rawCommon = runGit(worktreePath, ['rev-parse', '--git-common-dir']).trim();
    if (!rawCommon) return null;
    const resolvedCommon = safeRealpath(resolve(worktreePath, rawCommon));
    // 防御检查：常见情形是 <mainRepo>/.git；绝不把非 .git 的工作树根放进去。
    if (basename(resolvedCommon) !== '.git' && !resolvedCommon.endsWith('.git')) return null;
    return resolvedCommon;
  } catch {
    return null;
  }
}

/**
 * 为 linked git worktree 返回受限沙箱需要的 Git 元数据可写根列表：
 * `[commonDir, gitDir]`（去重），其中 `gitDir` 为 `<repo>/.git/worktrees/<name>`。
 * macOS Seatbelt 等机制下仅有 `commonDir` 时，`.git/worktrees/<name>` 仍可能被判定只读；
 * 同时显式放入 `gitDir` 可保证 `git add` / `git commit` 正常写入而不暴露主工作区工作树。
 */
export function worktreeGitWritableRoots(worktreePath) {
  const commonDir = gitCommonDirForWorktree(worktreePath);
  if (!commonDir) return [];
  const roots = [commonDir];
  try {
    const rawGitDir = runGit(worktreePath, ['rev-parse', '--git-dir']).trim();
    if (rawGitDir) {
      const resolvedGitDir = safeRealpath(resolve(worktreePath, rawGitDir));
      if (resolvedGitDir !== commonDir && resolvedGitDir.startsWith(`${commonDir}${sep}`)) {
        roots.push(resolvedGitDir);
      }
    }
  } catch {
    // 忽略 git-dir 探测异常，至少保留已验证的 commonDir。
  }
  return roots;
}

function parsePorcelainStatus(output) {
  const lines = String(output ?? '').split(/\r?\n/).filter(Boolean);
  let dirtyCount = 0;
  let untrackedCount = 0;
  const changedFiles = [];
  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (file) changedFiles.push(file);
    if (code === '??') untrackedCount += 1;
    else dirtyCount += 1;
  }
  return { dirtyCount, untrackedCount, changedFiles };
}

/** 查询单个成员 worktree 的实时只读 Git 状态，单点异常不抛 500。 */
export function inspectMemberWorktree({ repoRoot, worktreePath, branch }) {
  const repoValid = Boolean(repoRoot && existsSync(repoRoot));
  const exists = Boolean(worktreePath && existsSync(worktreePath) && statSync(worktreePath).isDirectory());
  let aheadCount = 0;
  let headCommit = null;
  let baseCommit = null;
  let branchExists = false;
  if (repoValid && branch) {
    branchExists = gitRefExists(repoRoot, `refs/heads/${branch}`);
    if (branchExists) {
      try {
        aheadCount = Number(runGit(repoRoot, ['rev-list', '--count', `HEAD..${branch}`]).trim()) || 0;
      } catch {
        aheadCount = 0;
      }
      try {
        baseCommit = runGit(repoRoot, ['merge-base', 'HEAD', branch]).trim().slice(0, 12);
      } catch {
        baseCommit = null;
      }
    }
  }
  if (!exists) {
    return {
      path: worktreePath ?? null,
      branch: branch ?? null,
      branchExists,
      exists: false,
      dirtyCount: 0,
      untrackedCount: 0,
      aheadCount,
      headCommit,
      baseCommit,
      changedFiles: [],
      diffStat: '',
      error: '工作树目录不存在',
    };
  }
  try {
    const porcelain = runGit(worktreePath, ['status', '--porcelain']);
    const { dirtyCount, untrackedCount, changedFiles } = parsePorcelainStatus(porcelain);
    try { headCommit = runGit(worktreePath, ['rev-parse', '--short', 'HEAD']).trim(); } catch { headCommit = null; }
    let diffStat = '';
    try {
      const workDiff = runGit(worktreePath, ['diff', '--stat']).trim();
      const branchDiff = repoValid && branchExists && aheadCount > 0
        ? runGit(repoRoot, ['diff', '--stat', `HEAD...${branch}`]).trim()
        : '';
      diffStat = [branchDiff, workDiff].filter(Boolean).join('\n');
    } catch {
      diffStat = '';
    }
    return {
      path: worktreePath,
      branch: branch ?? null,
      branchExists,
      exists: true,
      dirtyCount,
      untrackedCount,
      aheadCount,
      headCommit,
      baseCommit,
      changedFiles,
      diffStat,
      error: null,
    };
  } catch (error) {
    return {
      path: worktreePath,
      branch: branch ?? null,
      branchExists,
      exists: false,
      dirtyCount: 0,
      untrackedCount: 0,
      aheadCount,
      headCommit,
      baseCommit,
      changedFiles: [],
      diffStat: '',
      error: error.message,
    };
  }
}

/** 受保护合入：校验主工作区干净、worktree 无未提交修改、冲突时立即 git merge --abort。 */
export function mergeMemberWorktree({ repoRoot, worktreePath, branch }) {
  const repoInfo = inspectGitRepoForWorktree(repoRoot);
  const status = inspectMemberWorktree({ repoRoot: repoInfo.repoRoot, worktreePath, branch });
  if (!status.exists) throw new Error(`成员 worktree 目录不存在（${worktreePath ?? '未知路径'}），无法合入`);
  if (!status.branchExists) throw new Error(`分支 ${branch ?? '未知'} 不存在，无法合入`);
  if (status.dirtyCount > 0 || status.untrackedCount > 0) {
    throw new Error(`成员 worktree 仍有未提交修改（${status.dirtyCount} 处已修改，${status.untrackedCount} 个未跟踪文件），请先在分支提交后再合入`);
  }
  const mainStatus = parsePorcelainStatus(runGit(repoInfo.repoRoot, ['status', '--porcelain']));
  if (mainStatus.dirtyCount > 0 || mainStatus.untrackedCount > 0) {
    throw new Error('主工作区存在未提交改动，请先暂存、提交或清理后再合入成员分支');
  }
  if (status.aheadCount === 0) {
    return { merged: false, alreadyUpToDate: true, branch, commit: status.headCommit };
  }
  try {
    runGit(repoInfo.repoRoot, ['merge', '--no-ff', branch, '-m', `Merge worktree branch ${branch}`]);
    const commit = runGit(repoInfo.repoRoot, ['rev-parse', '--short', 'HEAD']).trim();
    return { merged: true, alreadyUpToDate: false, branch, commit };
  } catch (error) {
    let conflicts = [];
    try {
      const unmerged = runGit(repoInfo.repoRoot, ['diff', '--name-only', '--diff-filter=U']).trim();
      conflicts = unmerged ? unmerged.split(/\r?\n/).filter(Boolean) : [];
    } catch { /* ignore */ }
    try { runGit(repoInfo.repoRoot, ['merge', '--abort']); } catch { /* ignore */ }
    const conflictNote = conflicts.length ? `（冲突文件: ${conflicts.join(', ')}）` : '';
    throw new Error(`合入分支 ${branch} 发生冲突，已自动中止合并并保留主工作区干净${conflictNote}: ${error.message}`, { cause: error });
  }
}

function pruneEmptyParents(worktreePath, stopRoot) {
  if (!worktreePath || !stopRoot) return;
  try {
    const parent = dirname(resolve(worktreePath));
    const root = resolve(stopRoot);
    if (parent !== root && parent.startsWith(root) && existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

/**
 * 保守销毁/清理 worktree：
 * - 干净且无未合并新提交（aheadCount === 0）时直接删除工作树与临时分支；
 * - 只要存在未提交改动或未合并提交且 !force，就原样保留目录与分支并返回 retained: true。
 */
export function removeMemberWorktree({ dataDir, repoRoot, worktreePath, branch, force = false }) {
  const status = inspectMemberWorktree({ repoRoot, worktreePath, branch });
  const hasUnsavedWork = status.dirtyCount > 0 || status.untrackedCount > 0 || status.aheadCount > 0;
  if (hasUnsavedWork && !force) {
    const parts = [];
    if (status.dirtyCount > 0) parts.push(`${status.dirtyCount} 处已修改文件`);
    if (status.untrackedCount > 0) parts.push(`${status.untrackedCount} 个未跟踪文件`);
    if (status.aheadCount > 0) parts.push(`${status.aheadCount} 个未合入提交`);
    return {
      removed: false,
      retained: true,
      path: worktreePath ?? null,
      branch: branch ?? null,
      dirtyCount: status.dirtyCount,
      untrackedCount: status.untrackedCount,
      aheadCount: status.aheadCount,
      reason: `成员 worktree 仍含${parts.join('、')}，已保守保留现场以免丢失代码`,
    };
  }
  const repoValid = Boolean(repoRoot && existsSync(repoRoot));
  if (repoValid && worktreePath) {
    try {
      if (existsSync(worktreePath)) {
        runGit(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
      } else {
        runGit(repoRoot, ['worktree', 'prune']);
      }
    } catch {
      if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
      try { runGit(repoRoot, ['worktree', 'prune']); } catch { /* ignore */ }
    }
  } else if (worktreePath && existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  if (repoValid && branch && gitRefExists(repoRoot, `refs/heads/${branch}`)) {
    try {
      runGit(repoRoot, ['branch', force ? '-D' : '-d', branch]);
    } catch {
      if (force) throw new Error(`强制删除分支 ${branch} 失败`);
      return {
        removed: false,
        retained: true,
        path: worktreePath ?? null,
        branch,
        dirtyCount: status.dirtyCount,
        untrackedCount: status.untrackedCount,
        aheadCount: status.aheadCount,
        reason: `分支 ${branch} 仍有未合并提交，已保守保留`,
      };
    }
  }
  if (dataDir && worktreePath) pruneEmptyParents(worktreePath, join(resolve(dataDir), WORKTREE_ROOT_DIR));
  return {
    removed: true,
    retained: false,
    path: worktreePath ?? null,
    branch: branch ?? null,
  };
}
