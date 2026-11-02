import { realpathSync, statSync, openSync, fstatSync, closeSync, constants, createReadStream } from 'node:fs';
import { resolve, relative, isAbsolute, basename } from 'node:path';

export function openResultFile(bus, { group, panel, path }) {
  if (typeof path !== 'string' || !path || path.includes('\0') || Boolean(group) === Boolean(panel)) throw new Error('文件引用无效');
  let root;
  if (group) {
    const team = bus.store.group(group);
    if (team.policy === 'communication') throw new Error('此团队仅允许沟通');
    root = team.workspace;
  } else root = bus.panelAgent()?.workspace;
  if (!root) throw new Error('尚未选择工作文件夹');
  root = realpathSync(root);
  const file = realpathSync(resolve(root, path));
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('文件不在当前工作文件夹内');
  const privateRelative = relative(realpathSync(bus.store.directory), file);
  if (!privateRelative || (!isAbsolute(privateRelative) && privateRelative !== '..' && !privateRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) throw new Error('不能下载框架内部数据');
  const expected = statSync(file);
  if (!expected.isFile()) throw new Error('只能下载普通文件');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || expected.ino !== actual.ino || expected.dev !== actual.dev || realpathSync(file) !== file) throw new Error('文件已变化，请重试');
    return { stream: createReadStream(file, { fd, autoClose: true }), name: basename(file), size: actual.size };
  } catch (error) { closeSync(fd); throw error; }
}
