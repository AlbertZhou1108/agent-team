import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MessageAttachments from '@/components/ai-elements/MessageAttachments.vue';
import type { MessageAttachment } from '@/shared/api/raw-types';
import { formatAttachmentSize, TEXT_PREVIEW_LIMIT } from '@/shared/attachment-types';

function render(attachments: MessageAttachment[]) {
  const host = defineComponent({
    setup() {
      return () => h(MessageAttachments, { attachments });
    },
  });
  return renderToString(createSSRApp(host));
}

import type { MessageAttachment as Sample } from '@/shared/api/raw-types';
const image: Sample = { id: 'a1', name: 'photo.jpg', mediaType: 'image/jpeg', size: 2048, availability: 'available' };
const text: Sample = { id: 'a2', name: 'notes.md', mediaType: 'text/plain', size: 512, availability: 'available' };
const missing: Sample = { id: 'a3', name: 'lost.png', mediaType: 'image/png', size: 99, availability: 'missing' };

describe('message attachments preview', () => {
  it('renders image thumbs, text chips and missing markers without opening dialogs', async () => {
    const html = await render([image, text, missing]);
    expect(html).toContain('查看图片附件 photo.jpg');
    expect(html).toContain('预览文本附件 notes.md');
    expect(html).toContain('附件缺失');
    // 灯箱/预览弹层未打开:不渲染灯箱大图与下载工具条(缩略图本身的 <img> 属于条目)。
    expect(html).not.toContain('max-h-[82vh]');
    expect(html).not.toContain('aria-label="下载');
    expect(html).not.toContain('正在读取内容');
  });

  it('renders nothing when the message has no attachments', async () => {
    const html = await render([]);
    expect(html).not.toContain('预览文本附件');
    expect(html).not.toContain('附件缺失');
  });

  it('formats sizes and keeps the text preview limit honest', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(TEXT_PREVIEW_LIMIT).toBe(200 * 1024);
  });
});
