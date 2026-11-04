import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

// 附件模块:上传、验证、落盘、读取、绑定、回合输入准备和未发送清理的唯一收口。
// 路径解析与文件系统细节不暴露给 HTTP、PanelSessions 或 adapters;外部方法:
// upload / read / discard / bindTx(仅供 Store transaction 调用) / prepare / cleanup。
//
// 存储根固定在框架数据目录 <data>/attachments 下:附件副本是框架数据,
// 不进入用户的私人工作区(那是 Agent 与用户的工作区域),更换工作区也不影响已有附件。

// 类型注册表:按原始文件名的扩展名分类(不信任客户端 Content-Type)。
// 图片类经完整校验后走宿主原生图片输入;文本类统一 UTF-8 校验后由宿主文件工具读取。
export const ATTACHMENT_IMAGE_TYPES = Object.freeze({
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
});

// GIF/WebP/HEIC 的宿主读取(Codex localImage 等)尚未纵向验证,PDF/Office 需宿主侧
// 解析方案——验证通过后再扩,避免"传得上去、读不了"的静默失败。
export const ATTACHMENT_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.json', '.jsonc', '.csv', '.tsv', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.properties', '.env', '.xml', '.html', '.htm', '.css',
  '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py',
  '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.sql', '.r', '.lua', '.pl', '.vim',
  '.proto', '.graphql', '.gradle', '.cmake', '.dart', '.scala', '.log', '.diff', '.patch',
]);

// 无扩展名但常见的文本文件(按整名匹配)。
export const ATTACHMENT_TEXT_NAMES = new Set([
  '.env', 'makefile', 'dockerfile', 'license', 'readme', 'changelog', '.gitignore', '.editorconfig', '.npmrc',
]);

// 按扩展名分类;返回 'image/png' | 'image/jpeg' | 'text/plain' | null(不支持)。
export function classifyAttachmentName(name) {
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot) : '';
  for (const [mediaType, extensions] of Object.entries(ATTACHMENT_IMAGE_TYPES)) {
    if (extensions.includes(extension)) return mediaType;
  }
  if (ATTACHMENT_TEXT_EXTENSIONS.has(extension) || ATTACHMENT_TEXT_NAMES.has(lower)) return 'text/plain';
  return null;
}
export const UNSENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 稳定错误码:HTTP 层按 code 映射状态(413/415/422/404/409),错误 JSON 只带 {code,error}。
export function attachmentError(code, message) {
  return Object.assign(new Error(message), { code });
}

// 解析 JPEG SOF 段取宽高;找不到帧头(截断/非 JPEG)返回 null。
function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export class Attachments {
  constructor(bus) {
    // 只持有 bus 引用,方法调用时才访问 store:不依赖 Bus 完成构造。
    this.bus = bus;
  }

  // 存储根:<data>/attachments。数据目录由 Store 以 0700 创建,这里只管理附件子目录。
  #rootPath() {
    const root = resolve(this.bus.store.directory, 'attachments');
    let stat;
    try { stat = lstatSync(root); } catch { return root; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw attachmentError('storage_unavailable', '附件存储目录无效');
    }
    return root;
  }

  #ensureRoot() {
    const root = resolve(this.bus.store.directory, 'attachments');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // mkdir 后复查:防止预先存在的 symlink 被当作存储目录沿用。
    return this.#rootPath();
  }

  #agentId(agentId) {
    if (typeof agentId !== 'string' || !agentId) throw attachmentError('not_found', 'Panel Agent 不存在');
    if (!this.bus.store.get('SELECT 1 FROM panel_agents WHERE id=?', agentId)) {
      throw attachmentError('not_found', 'Panel Agent 不存在');
    }
    return agentId;
  }

  #validateOriginalName(name) {
    if (typeof name !== 'string' || !name.trim()) throw attachmentError('invalid_request', '附件文件名无效');
    if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
      throw attachmentError('invalid_request', '附件文件名不能包含路径分隔符');
    }
    if (name.length > 255) throw attachmentError('invalid_request', '附件文件名过长');
    return name;
  }

  #row(agentId, id) {
    if (typeof id !== 'string' || !id) throw attachmentError('not_found', '附件不存在');
    const row = this.bus.store.get('SELECT * FROM attachments WHERE id=? AND panel_agent_id=?', id, agentId);
    if (!row) throw attachmentError('not_found', '附件不存在');
    return row;
  }

  #finalPath(storageName) {
    const path = join(this.#rootPath(), storageName);
    let stat;
    try { stat = lstatSync(path); } catch {
      throw attachmentError('not_found', '附件文件不存在');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw attachmentError('not_found', '附件文件不存在');
    return path;
  }

  #checkTextContent(text) {
    for (const character of text) {
      const code = character.codePointAt(0);
      // 允许 \t \n \r;其余 C0、DEL 和 C1 视为二进制控制字符。
      if (code === 9 || code === 10 || code === 13) continue;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        throw attachmentError('invalid_content', 'TXT 包含二进制控制字符');
      }
    }
  }

  #validatePng(filePath, settings) {
    const head = Buffer.alloc(26);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) throw attachmentError('invalid_content', 'PNG 签名无效');
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    if (!width || !height) throw attachmentError('invalid_content', 'PNG 尺寸无效');
    // 先按 IHDR 快速拒绝超限,再完整解码;头检查不作为完整验证的替代。
    if (width * height > settings.maxImagePixels) {
      throw attachmentError('invalid_content', `PNG 超过图片像素上限 ${settings.maxImagePixels}`);
    }
    let png;
    try {
      png = PNG.sync.read(readFileSync(filePath));
    } catch {
      throw attachmentError('invalid_content', 'PNG 无法完整解码');
    }
    if (!png.width || !png.height || png.width * png.height > settings.maxImagePixels) {
      throw attachmentError('invalid_content', 'PNG 无效或超过图片像素上限');
    }
  }

  #validateJpeg(filePath, settings) {
    const buffer = readFileSync(filePath);
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
      throw attachmentError('invalid_content', 'JPEG 签名无效');
    }
    // 先从 SOF 段读取尺寸快速拒绝超限,再完整解码;头检查不作为完整验证的替代。
    const dimensions = jpegDimensions(buffer);
    if (!dimensions) throw attachmentError('invalid_content', 'JPEG 缺少图像帧信息');
    if (dimensions.width * dimensions.height > settings.maxImagePixels) {
      throw attachmentError('invalid_content', `JPEG 超过图片像素上限 ${settings.maxImagePixels}`);
    }
    let decoded;
    try {
      decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 512 });
    } catch {
      throw attachmentError('invalid_content', 'JPEG 无法完整解码');
    }
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > settings.maxImagePixels) {
      throw attachmentError('invalid_content', 'JPEG 无效或超过图片像素上限');
    }
  }

  // 上传:边接收边限额、算 SHA-256、流式校验;完整写入并原子 rename 后再插入记录。
  // 哈希仅作为流完整性副产物计算,按计划固定表结构不落库。
  async upload(agentId, stream, { name }) {
    agentId = this.#agentId(agentId);
    const originalName = this.#validateOriginalName(name);
    // 类型由原始文件名的扩展名决定,客户端声明的 Content-Type 仅作参考。
    const mediaType = classifyAttachmentName(originalName);
    if (!mediaType) {
      throw attachmentError('unsupported_media_type', '不支持的文件类型：当前支持常见文本文件与 PNG/JPEG 图片');
    }
    const settings = this.bus.store.attachmentSettings();
    const root = this.#ensureRoot();
    const id = randomUUID();
    const storageName = id; // 存储名一律服务端 UUID,不接受客户端指定。
    const partPath = join(root, `${storageName}.part`);
    const finalPath = join(root, storageName);

    let source = stream;
    if (Buffer.isBuffer(source)) source = Readable.from(source);
    const hash = createHash('sha256');
    const decoder = mediaType === 'text/plain' ? new TextDecoder('utf-8', { fatal: true }) : null;
    let size = 0;
    const fd = openSync(partPath, 'wx', 0o600);
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > settings.maxFileBytes) {
          throw attachmentError('payload_too_large', `附件超过单文件大小上限 ${settings.maxFileBytes} 字节`);
        }
        hash.update(chunk);
        if (decoder) {
          let text;
          try { text = decoder.decode(chunk, { stream: true }); } catch {
            throw attachmentError('invalid_content', 'TXT 不是有效的 UTF-8 文本');
          }
          this.#checkTextContent(text);
        }
        let written = 0;
        while (written < chunk.length) written += writeSync(fd, chunk, written);
      }
      if (decoder) {
        let tail;
        try { tail = decoder.decode(); } catch {
          throw attachmentError('invalid_content', 'TXT 不是有效的 UTF-8 文本');
        }
        this.#checkTextContent(tail);
      }
      if (mediaType === 'image/png') this.#validatePng(partPath, settings);
      if (mediaType === 'image/jpeg') this.#validateJpeg(partPath, settings);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      try { unlinkSync(partPath); } catch { /* 清理由定时 cleanup 兜底 */ }
      throw error;
    }
    closeSync(fd);

    renameSync(partPath, finalPath);
    try {
      this.bus.store.run(
        'INSERT INTO attachments(id,panel_agent_id,original_name,media_type,size,storage_name,created_at,panel_message_id,ordinal) VALUES(?,?,?,?,?,?,?,NULL,NULL)',
        id,
        agentId,
        originalName,
        mediaType,
        size,
        storageName,
        new Date().toISOString(),
      );
    } catch (error) {
      // DB 插入失败必须删除最终文件,不留无记录的孤儿。
      try { unlinkSync(finalPath); } catch { console.error('[attachments] 记录插入失败后清理文件失败:', finalPath); }
      throw error;
    }
    return { id, name: originalName, mediaType, size };
  }

  // 读取:返回元数据与文件流,绝不返回路径。
  read(agentId, id) {
    agentId = this.#agentId(agentId);
    const row = this.#row(agentId, id);
    const path = this.#finalPath(row.storage_name);
    return {
      id: row.id,
      name: row.original_name,
      mediaType: row.media_type,
      size: row.size,
      stream: createReadStream(path),
    };
  }

  // 移除未发送草稿:先条件删除行(只删未绑定),再删文件;已绑定/不存在统一 not_found。
  discard(agentId, id) {
    agentId = this.#agentId(agentId);
    const row = this.#row(agentId, id);
    const deleted = this.bus.store.run(
      'DELETE FROM attachments WHERE id=? AND panel_agent_id=? AND panel_message_id IS NULL',
      id,
      agentId,
    );
    if (!deleted.changes) throw attachmentError('not_found', '附件不存在');
    try {
      unlinkSync(join(this.#rootPath(), row.storage_name));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[attachments] 移除附件文件失败:', error.message);
    }
    return { discarded: id };
  }

  // 绑定:只在 Store transaction 内调用;验证归属、未绑定、未过期,全部通过才写入。
  bindTx(agentId, messageId, orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) throw attachmentError('invalid_request', '附件列表为空');
    if (new Set(orderedIds).size !== orderedIds.length) throw attachmentError('invalid_request', '附件列表重复');
    const cutoff = new Date(Date.now() - UNSENT_RETENTION_MS).toISOString();
    orderedIds.forEach((id, ordinal) => {
      const row = this.bus.store.get('SELECT * FROM attachments WHERE id=? AND panel_agent_id=?', id, agentId);
      if (!row) throw attachmentError('not_found', `附件不存在: ${id}`);
      if (row.panel_message_id) throw attachmentError('conflict', `附件已被其他消息使用: ${id}`);
      if (row.created_at < cutoff) throw attachmentError('conflict', `附件已超过暂存期限,请重新上传: ${id}`);
      const updated = this.bus.store.run(
        'UPDATE attachments SET panel_message_id=?,ordinal=? WHERE id=? AND panel_message_id IS NULL',
        messageId,
        ordinal,
        id,
      );
      if (!updated.changes) throw attachmentError('conflict', `附件状态已变化,请重试: ${id}`);
    });
  }

  // 为实际回合准备宿主输入:包含服务端解析出的副本路径,仅供 adapter 内部使用。
  prepare(agentId, orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return [];
    agentId = this.#agentId(agentId);
    const root = this.#rootPath();
    return orderedIds.map(id => {
      const row = this.bus.store.get(
        'SELECT id,original_name,media_type,size,storage_name FROM attachments WHERE id=? AND panel_agent_id=?',
        id,
        agentId,
      );
      if (!row) throw attachmentError('attachment_missing', `附件不存在: ${id}`);
      let stat;
      try { stat = lstatSync(join(root, row.storage_name)); } catch {
        throw attachmentError('attachment_missing', '附件文件缺失,请重新上传');
      }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== row.size) {
        throw attachmentError('attachment_missing', '附件文件缺失或已损坏,请重新上传');
      }
      return { id: row.id, name: row.original_name, mediaType: row.media_type, size: row.size, path: join(root, row.storage_name) };
    });
  }

  // 历史附件 DTO:availability 由文件现状决定,记录与文件缺失都不隐藏附件。
  describeMessage(agentId, messageId) {
    // join panel_messages 核对归属,单查询完成,防跨 agent 引用。
    const rows = this.bus.store.all(
      `SELECT a.id,a.original_name,a.media_type,a.size,a.storage_name FROM attachments a
       JOIN panel_messages m ON m.id=a.panel_message_id
       WHERE a.panel_message_id=? AND m.panel_agent_id=? ORDER BY a.ordinal`,
      messageId,
      agentId,
    );
    if (!rows.length) return [];
    const root = this.#rootPath();
    return rows.map(row => {
      let availability = 'available';
      try {
        const stat = lstatSync(join(root, row.storage_name));
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== row.size) availability = 'missing';
      } catch {
        availability = 'missing';
      }
      return { id: row.id, name: row.original_name, mediaType: row.media_type, size: row.size, availability };
    });
  }

  // 清理:删除超过暂存期限且未绑定的记录和文件;*.part 按期限清扫(startup 传 0 全清)。
  // 与绑定通过条件删除 + SQLite 写事务串行,不能发送一个已经被清理的附件。
  cleanup(now, { partMaxAgeMs = UNSENT_RETENTION_MS } = {}) {
    const removed = { records: 0, parts: 0 };
    const cutoff = new Date(new Date(now).getTime() - UNSENT_RETENTION_MS).toISOString();
    const expired = this.bus.store.all(
      'SELECT id,storage_name FROM attachments WHERE panel_message_id IS NULL AND created_at < ?',
      cutoff,
    );
    if (expired.length) {
      const root = this.#rootPath();
      this.bus.store.transaction(() => {
        for (const row of expired) {
          const deleted = this.bus.store.run(
            'DELETE FROM attachments WHERE id=? AND panel_message_id IS NULL',
            row.id,
          );
          if (!deleted.changes) continue; // 清理期间被绑定:保留。
          removed.records += 1;
          try {
            unlinkSync(join(root, row.storage_name));
          } catch (error) {
            if (error.code !== 'ENOENT') console.error('[attachments] 清理附件文件失败:', error.message);
          }
        }
      });
    }
    const root = this.#rootPath();
    let names;
    try { names = readdirSync(root); } catch { return removed; }
    // partMaxAgeMs=0 表示启动清理:不设年龄门槛,全部 .part 都移除。
    const partCutoff = partMaxAgeMs > 0 ? new Date(now).getTime() - partMaxAgeMs : Infinity;
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      try {
        const stat = lstatSync(join(root, name));
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (stat.mtimeMs > partCutoff) continue;
        unlinkSync(join(root, name));
        removed.parts += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('[attachments] 清理临时文件失败:', error.message);
      }
    }
    return removed;
  }
}
