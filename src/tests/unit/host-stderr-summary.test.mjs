import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHostStderr } from '../../host-runtime/process.mjs';

// 真实 dsh 启动失败时 stderr 的第一行:根因 + 两处长路径,后面跟几十行堆栈。
const moduleFailure = `policy (file:///Library/Development/Projects/AgentProjects/agent-team/src/host-runtime/dsh-policy.mjs): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Library/Development/Projects/AgentProjects/agent-team/src/host-runtime/dsh-policy.mjs' imported from /Users/zhoujunxiang/.dsh/profiles/headless/
    at finalizeResolution (node:internal/modules/esm/resolve:275:11)
    at moduleResolve (node:internal/modules/esm/resolve:861:10)
    at defaultResolve (node:internal/modules/esm/resolve:985:11)
    at ModuleLoader.resolve (node:internal/modules/esm/loader:747:20)
    at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:320:38)
    at file:///Users/zhoujunxiang/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2728:77
`;

test('丢掉堆栈帧,只留根因那一行', () => {
  const summary = summarizeHostStderr(moduleFailure);
  assert.match(summary, /ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(summary, /^\s+at /m);
  assert.doesNotMatch(summary, /node:internal/);
  assert.ok(!summary.includes('\n'), '摘要应是单行,不含换行');
});

test('多行长文本截断到上限并保留省略号', () => {
  const summary = summarizeHostStderr(moduleFailure, { max: 80 });
  assert.ok(summary.length <= 80 + '…'.length);
  assert.ok(summary.endsWith('…'));
});

test('多处同类错误合并计数,不逐条铺开', () => {
  const three = [
    'policy: failed to import: Error [ERR_MODULE_NOT_FOUND]: cannot find a',
    '    at resolve (node:internal/modules/esm/resolve:1:1)',
    'model-observer: failed to import: Error [ERR_MODULE_NOT_FOUND]: cannot find b',
    'telemetry-observer: failed to import: Error [ERR_MODULE_NOT_FOUND]: cannot find c',
  ].join('\n');
  const summary = summarizeHostStderr(three);
  assert.match(summary, /另有 2 处同类错误/);
  assert.ok(summary.split('\n').length === 1);
});

test('额度类错误保留可读原因', () => {
  const quota = '[lm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s) (dsh: QUOTA: Insufficient Balance (request_id: 35b42063))';
  assert.match(summarizeHostStderr(quota), /Insufficient Balance/);
});

test('空输入回落到空串,由调用方给默认话术', () => {
  assert.equal(summarizeHostStderr(''), '');
  assert.equal(summarizeHostStderr('   \n  \n'), '');
  assert.equal(summarizeHostStderr(undefined), '');
});

test('纯堆栈输入不产生根因', () => {
  const onlyStack = ['    at a (node:internal/x:1:1)', '    at b (node:internal/y:2:2)'].join('\n');
  assert.equal(summarizeHostStderr(onlyStack), '');
});
