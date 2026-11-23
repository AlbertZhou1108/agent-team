import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSandboxConfig } from '../../hosts/policies.mjs';
import { MAX_FILE_PREVIEW_BYTES, previewGroupTextFile } from '../../hosts/file-preview.mjs';
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
  normalizeWorkflowTemplateId,
  workflowPromptHint,
} from '../../hosts/workflow-templates.mjs';
import {
  assertWorktreeUsable,
  createMemberWorktree,
  gitCommonDirForWorktree,
  inspectGitRepoForWorktree,
  inspectMemberWorktree,
  mergeMemberWorktree,
  removeMemberWorktree,
  rollbackCreatedWorktrees,
  worktreeGitWritableRoots,
} from '../../hosts/worktree.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeGitRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-wt-'));
  const repo = join(root, 'repo');
  const dataDir = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'README.md'), '# Repo\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  t.after(() => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  return { root, repo, dataDir };
}

test('workflow template registry validates ids and exposes delivery conventions without locks', () => {
  const templates = listWorkflowTemplates();
  assert.deepEqual(templates.map(item => item.id), ['standard-dev', 'quick-fix']);
  assert.equal(normalizeWorkflowTemplateId(null), null);
  assert.equal(normalizeWorkflowTemplateId('none'), null);
  assert.equal(normalizeWorkflowTemplateId('  standard-dev '), 'standard-dev');
  assert.throws(() => normalizeWorkflowTemplateId('unknown-flow'), /未知研发工作流模板/);
  assert.ok(getWorkflowTemplate('standard-dev')?.charter.includes('大文档路径交付'));
  assert.match(workflowPromptHint('standard-dev'), /只传「核心结论 \+ 文件路径/);
  assert.equal(workflowPromptHint(null), '');
});

test('inspectGitRepoForWorktree rejects non-git, subdirectory and empty HEAD repositories', t => {
  const nonGit = mkdtempSync(join(tmpdir(), 'non-git-'));
  const emptyGit = mkdtempSync(join(tmpdir(), 'empty-git-'));
  t.after(() => {
    try { rmSync(nonGit, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(emptyGit, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  assert.throws(() => inspectGitRepoForWorktree(nonGit), /有效的 Git 仓库根目录/);

  git(emptyGit, ['init']);
  assert.throws(() => inspectGitRepoForWorktree(emptyGit), /初始提交/);

  const { repo } = makeGitRepo(t);
  const sub = join(repo, 'nested');
  mkdirSync(sub, { recursive: true });
  assert.throws(() => inspectGitRepoForWorktree(sub), /根目录/);
});

test('create, isolate writes, protected merge, conflict abort and conservative removal behave safely', t => {
  const { repo, dataDir } = makeGitRepo(t);
  const repoInfo = inspectGitRepoForWorktree(repo);
  const reserved = new Set();

  const wtA = createMemberWorktree({
    dataDir, groupId: 'group-12345678', memberId: 'member-aaaa', memberName: '前端开发',
    repoInfo, reservedBranches: reserved,
  });
  const wtB = createMemberWorktree({
    dataDir, groupId: 'group-12345678', memberId: 'member-bbbb', memberName: '后端开发',
    repoInfo, reservedBranches: reserved,
  });

  assert.notEqual(wtA.worktreePath, wtB.worktreePath);
  assert.notEqual(wtA.worktreeBranch, wtB.worktreeBranch);
  assert.ok(wtA.worktreeBranch.startsWith('agent-team/group123-'));
  assert.ok(gitCommonDirForWorktree(wtA.worktreePath));
  assert.equal(gitCommonDirForWorktree(repo), null);

  // 并发写入各自 worktree 互不污染，也不污染主仓库工作区。
  writeFileSync(join(wtA.worktreePath, 'a.txt'), 'from A\n');
  writeFileSync(join(wtB.worktreePath, 'b.txt'), 'from B\n');
  assert.equal(existsSync(join(repo, 'a.txt')), false);
  assert.equal(existsSync(join(wtB.worktreePath, 'a.txt')), false);

  // 有未提交修改时拒绝直接合入、拒绝普通删除（保守保留）。
  assert.throws(() => mergeMemberWorktree({ repoRoot: repo, ...wtA, branch: wtA.worktreeBranch }), /未提交/);
  const retainedDirty = removeMemberWorktree({
    dataDir, repoRoot: repo, worktreePath: wtA.worktreePath, branch: wtA.worktreeBranch,
  });
  assert.equal(retainedDirty.retained, true);
  assert.equal(existsSync(wtA.worktreePath), true);

  // wtA 提交后仍未合并：普通移除保守保留；脏主工作区拒合。
  git(wtA.worktreePath, ['add', 'a.txt']);
  git(wtA.worktreePath, ['commit', '-m', 'add a']);
  writeFileSync(join(repo, 'untracked.tmp'), 'dirty main\n');
  assert.throws(() => mergeMemberWorktree({ repoRoot: repo, worktreePath: wtA.worktreePath, branch: wtA.worktreeBranch }), /主工作区/);
  rmSync(join(repo, 'untracked.tmp'));

  const retainedAhead = removeMemberWorktree({
    dataDir, repoRoot: repo, worktreePath: wtA.worktreePath, branch: wtA.worktreeBranch,
  });
  assert.equal(retainedAhead.retained, true);
  assert.equal(retainedAhead.aheadCount, 1);

  // 合入主分支成功后，wtA 未合并计数归零，随后可自动安全清理。
  const merged = mergeMemberWorktree({ repoRoot: repo, worktreePath: wtA.worktreePath, branch: wtA.worktreeBranch });
  assert.equal(merged.merged, true);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'from A\n');
  const cleanedAfterMerge = removeMemberWorktree({
    dataDir, repoRoot: repo, worktreePath: wtA.worktreePath, branch: wtA.worktreeBranch,
  });
  assert.equal(cleanedAfterMerge.removed, true);
  assert.equal(existsSync(wtA.worktreePath), false);

  // 制造分支冲突：验证冲突合入自动中止且主工作区不受损。
  writeFileSync(join(repo, 'conflict.txt'), 'main side\n');
  git(repo, ['add', 'conflict.txt']);
  git(repo, ['commit', '-m', 'main conflict']);
  writeFileSync(join(wtB.worktreePath, 'conflict.txt'), 'branch side\n');
  git(wtB.worktreePath, ['add', 'b.txt', 'conflict.txt']);
  git(wtB.worktreePath, ['commit', '-m', 'branch conflict']);
  assert.throws(() => mergeMemberWorktree({ repoRoot: repo, worktreePath: wtB.worktreePath, branch: wtB.worktreeBranch }), /自动中止合并/);
  assert.equal(readFileSync(join(repo, 'conflict.txt'), 'utf8'), 'main side\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');

  // 删除目录后 assertWorktreeUsable 明确拒绝，rollback 也能清干净强制清理目标。
  rmSync(wtB.worktreePath, { recursive: true, force: true });
  assert.throws(() => assertWorktreeUsable(wtB.worktreePath), /不存在或已被删除/);
  const statusMissing = inspectMemberWorktree({ repoRoot: repo, worktreePath: wtB.worktreePath, branch: wtB.worktreeBranch });
  assert.equal(statusMissing.exists, false);

  rollbackCreatedWorktrees(repo, [{ worktreePath: wtB.worktreePath, worktreeBranch: wtB.worktreeBranch }]);
  assert.equal(existsSync(wtB.worktreePath), false);
});

test('codexSandboxConfig only appends git common-dir and worktree git-dir without opening main repo tree', t => {
  const { repo, dataDir } = makeGitRepo(t);
  const repoInfo = inspectGitRepoForWorktree(repo);
  const wt = createMemberWorktree({
    dataDir, groupId: 'g-sandbox', memberId: 'm-codex', memberName: 'codex', repoInfo, reservedBranches: new Set(),
  });
  const roots = worktreeGitWritableRoots(wt.worktreePath);
  const sandbox = codexSandboxConfig({ mode: 'workspace-write', allowShell: true }, wt.worktreePath, roots);
  assert.equal(roots.length, 2);
  assert.equal(sandbox.turnSandboxPolicy.writableRoots[0], wt.worktreePath);
  assert.equal(sandbox.turnSandboxPolicy.writableRoots[1], realpathSync(join(repo, '.git')));
  assert.equal(sandbox.turnSandboxPolicy.writableRoots[2], realpathSync(join(repo, '.git', 'worktrees', 'm-codex')));
  assert.equal(sandbox.turnSandboxPolicy.writableRoots.includes(realpathSync(repo)), false);
});

test('previewGroupTextFile enforces realpath boundary, extensions and 128KB cap', t => {
  const { root, repo, dataDir } = makeGitRepo(t);
  const outsideFile = join(root, 'secret.md');
  writeFileSync(outsideFile, '# Secret\n');
  writeFileSync(join(repo, 'docs.md'), '# Spec Heading\nhello\n');
  writeFileSync(join(repo, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  writeFileSync(join(repo, 'big.txt'), 'a'.repeat(MAX_FILE_PREVIEW_BYTES + 200));
  symlinkSync(outsideFile, join(repo, 'escape.md'));

  const repoInfo = inspectGitRepoForWorktree(repo);
  const wt = createMemberWorktree({
    dataDir, groupId: 'g-prev', memberId: 'm-wt', memberName: 'writer', repoInfo, reservedBranches: new Set(),
  });
  writeFileSync(join(wt.worktreePath, 'branch-note.md'), '# Branch Spec\n');

  const group = { workspace: repo };
  const members = [{ id: 'm-wt', name: 'writer', workspace_mode: 'worktree', worktree_path: wt.worktreePath }];

  const md = previewGroupTextFile({ group, members, filePath: 'docs.md#L1-L2' });
  assert.equal(md.path, 'docs.md');
  assert.match(md.content, /Spec Heading/);

  const wtDoc = previewGroupTextFile({ group, members, filePath: 'branch-note.md', memberId: 'm-wt' });
  assert.equal(wtDoc.rootKind, 'worktree');
  assert.match(wtDoc.content, /Branch Spec/);

  const truncated = previewGroupTextFile({ group, members, filePath: 'big.txt' });
  assert.equal(truncated.truncated, true);
  assert.equal(Buffer.byteLength(truncated.content), MAX_FILE_PREVIEW_BYTES);

  assert.throws(() => previewGroupTextFile({ group, members, filePath: '../secret.md' }), /边界/);
  assert.throws(() => previewGroupTextFile({ group, members, filePath: 'escape.md' }), /边界/);
  assert.throws(() => previewGroupTextFile({ group, members, filePath: outsideFile }), /边界/);
  assert.throws(() => previewGroupTextFile({ group, members, filePath: 'photo.png' }), /仅支持预览/);
});
