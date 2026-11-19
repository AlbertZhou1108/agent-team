// 桌面应用集成的 HTTP 边界:状态投影、额度确认门在 API 层的契约。
// 检测与验证的完整流程由 process/desktop-verify.test.mjs 用 fake bundle 覆盖;
// 这里不触发真实文件系统探测,只断言公共 API 形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { serverScenario } from '../support/fixture.mjs';

test('desktop application status lists every supported kind with one user-visible state', async t => {
  const { url } = await serverScenario(t, {});
  const response = await fetch(new URL('/api/desktop/applications', url));
  assert.equal(response.status, 200);
  const applications = await response.json();
  assert.deepEqual(applications.map(item => item.kind).sort(), ['claude', 'codex', 'dsh']);
  for (const item of applications) {
    assert.equal(item.installed, false);
    assert.equal(item.state, 'unavailable');
    assert.match(item.reason, /未检测到/);
  }
});

test('verification at the API boundary demands explicit quota confirmation before running', async t => {
  const { url } = await serverScenario(t, {});
  const response = await fetch(new URL('/api/desktop/verify', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.slice(0, -1) },
    body: JSON.stringify({ kind: 'codex' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.needsConfirmation, true);
  assert.match(result.cost, /模型额度/);

  const invalid = await fetch(new URL('/api/desktop/verify', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.slice(0, -1) },
    body: JSON.stringify({}),
  });
  assert.equal(invalid.status, 400);
});

test('disable/enable/remove target an installed application and reject unknown kinds', async t => {
  const { url } = await serverScenario(t, {});
  const response = await fetch(new URL('/api/desktop/disable', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.slice(0, -1) },
    body: JSON.stringify({ kind: 'dsh' }),
  });
  // 路由异常统一以纯文本错误返回(fail)。
  assert.equal(response.status, 400);
  assert.match(await response.text(), /未检测到桌面应用安装/);
});
