import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  AGENT_CHECKS,
  formatHookContext,
  formatHostHookOutput,
  matchAgentChecks,
} from '../../../scripts/agent-checks.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('注册表内所有检查脚本均真实存在', () => {
  assert.ok(AGENT_CHECKS.length >= 2);
  for (const entry of AGENT_CHECKS) {
    assert.ok(existsSync(join(repoRoot, entry.check)), `检查脚本缺失: ${entry.check}`);
  }
});

test('按路径域分发对应检查（兼容 POSIX 与 Windows 分隔符）', () => {
  assert.deepEqual(
    matchAgentChecks('/repo/web/src/App.vue').map(x => x.name),
    ['design', 'layering'],
  );
  assert.deepEqual(
    matchAgentChecks('C:\\repo\\web\\tests\\shared\\motion.test.ts').map(x => x.name),
    ['layering'],
  );
  assert.deepEqual(
    matchAgentChecks('/repo/src/tests/contract/core.test.mjs').map(x => x.name),
    ['layering'],
  );
  assert.deepEqual(matchAgentChecks('/repo/README.md'), []);
  assert.deepEqual(matchAgentChecks(''), []);
});

test('按宿主环境变量输出对应 hook JSON 结构', () => {
  const context = formatHookContext([{ entry: AGENT_CHECKS[0], output: 'web/src/Foo.vue:10 违例' }]);
  assert.match(context, /scripts\/check-design\.mjs/);
  assert.match(context, /Foo\.vue:10/);

  const zcode = JSON.parse(formatHostHookOutput(context, {}));
  assert.equal(zcode.additionalContext, context);
  assert.equal(zcode.hookSpecificOutput, undefined);

  const claude = JSON.parse(formatHostHookOutput(context, { CLAUDE_PROJECT_DIR: '/repo' }));
  assert.equal(claude.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(claude.hookSpecificOutput.additionalContext, context);

  const both = JSON.parse(formatHostHookOutput(context, { CLAUDE_PROJECT_DIR: '/repo', ZCODE_PROJECT_DIR: '/repo' }));
  assert.equal(both.additionalContext, context);
});
