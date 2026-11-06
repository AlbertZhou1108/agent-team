import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingCount } from '../../electron/service.mjs';
import { pickDirectory } from '../../electron/dialogs.mjs';
import { applicationMenuTemplate } from '../../electron/menus.mjs';

function menuItem(template, label) {
  for (const menu of template) {
    const found = menu.submenu?.find(item => item.label === label);
    if (found) return found;
  }
  return undefined;
}

test('待办数 = 待答复互动卡 + 等待回复，字段缺失按 0', () => {
  assert.equal(pendingCount({ pending: [{}, {}], waiting: [{}] }), 3);
  assert.equal(pendingCount({ pending: [], waiting: [] }), 0);
  assert.equal(pendingCount({}), 0);
  assert.equal(pendingCount(null), 0);
});

test('目录对话框的选中、取消、空列表与异常', async () => {
  assert.deepEqual(await pickDirectory(async () => ({ canceled: false, filePaths: ['/tmp/picked'] }), {}), { path: '/tmp/picked' });
  assert.deepEqual(await pickDirectory(async () => ({ canceled: true, filePaths: [] }), {}), { path: null });
  assert.deepEqual(await pickDirectory(async () => ({ canceled: false, filePaths: [] }), {}), { path: null });
  await assert.rejects(pickDirectory(async () => { throw new Error('dialog failed'); }, {}), /dialog failed/);
});

test('应用菜单启用状态随服务地址与运行模式变化', () => {
  const offline = applicationMenuTemplate({ platform: 'darwin', panelUrl: null, dev: false });
  assert.equal(menuItem(offline, '在浏览器中打开').enabled, false);
  assert.equal(menuItem(offline, '停止本地服务').enabled, false);

  const online = applicationMenuTemplate({ platform: 'darwin', panelUrl: 'http://127.0.0.1:1234/', dev: false });
  assert.equal(menuItem(online, '在浏览器中打开').enabled, true);
  assert.equal(menuItem(online, '停止本地服务').enabled, true);

  const dev = applicationMenuTemplate({ platform: 'darwin', panelUrl: 'http://127.0.0.1:5173/', dev: true });
  assert.equal(menuItem(dev, '在浏览器中打开').enabled, true);
  assert.equal(menuItem(dev, '停止本地服务').enabled, false);

  assert.equal(applicationMenuTemplate({ platform: 'win32' })[0].label, '文件');
});
