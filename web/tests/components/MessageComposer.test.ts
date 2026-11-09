// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createComposerActions } from '@/components/ai-elements/composer-actions';
import MessageComposer from '@/components/ai-elements/MessageComposer.vue';
import type { ComposerAttachment } from '@/components/ai-elements/MessageComposer.vue';
import { useUiStore } from '@/stores/ui';
describe('shared message composer actions', () => {
  it('keeps IME and Shift+Enter as text input and sends Enter once', () => {
    const send = vi.fn();
    const actions = createComposerActions(() => ({ draft: 'hello', sending: false, disabled: false }), send);
    const key = (extra = {}) => actions.onKeydown({ key: 'Enter', preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent);
    key({ isComposing: true }); key({ shiftKey: true }); expect(send).not.toHaveBeenCalled();
    key(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('guards both form and keyboard submission while sending, disabled or empty', () => {
    const send = vi.fn(); const state = { draft: 'hello', sending: true, disabled: false };
    const actions = createComposerActions(() => state, send);
    actions.submit();
    state.sending = false; state.disabled = true;
    actions.onKeydown({ key: 'Enter', preventDefault() {} } as KeyboardEvent); actions.submit();
    state.disabled = false; state.draft = '  '; actions.submit();
    expect(send).not.toHaveBeenCalled();
  });
  it('allows attachment-only submission without text', () => {
    const send = vi.fn();
    const state = { draft: '', sending: false, disabled: false, hasAttachments: true };
    const actions = createComposerActions(() => state, send);
    actions.submit();
    state.hasAttachments = false;
    actions.submit();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 组件级行为用例（P1-4）：真实挂载输入区，验证键盘、IME、发送与附件禁用。
// 文件头已切到 happy-dom；上面的纯函数用例保持原样不动。
// ---------------------------------------------------------------------------

type MountComposerOptions = {
  sending?: boolean;
  disabled?: boolean;
  attachments?: ComposerAttachment[];
  modelValue?: string;
};

function mountComposer(options: MountComposerOptions = {}) {
  const pinia = createPinia();
  const ui = useUiStore(pinia);
  ui.composerCollapsed = false;
  return mount(MessageComposer, {
    props: {
      sending: false,
      disabled: false,
      modelValue: '',
      ...options,
    },
    global: { plugins: [pinia] },
  });
}

/** 输入内容并同步 v-model：组件用 defineModel，父级需要回写 prop。 */
async function typeDraft(wrapper: ReturnType<typeof mountComposer>, value: string) {
  await wrapper.find('textarea').setValue(value);
  await wrapper.setProps({ modelValue: value });
}

describe('MessageComposer 交互（组件级）', () => {
  it('表单提交一次并发出 submit，空内容时发送按钮保持禁用', async () => {
    const wrapper = mountComposer();
    const send = wrapper.get('[aria-label="发送"]');

    expect(send.attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')).toBeUndefined();

    await typeDraft(wrapper, '  发给团队的消息  ');
    expect(wrapper.get('[aria-label="发送"]').attributes('disabled')).toBeUndefined();
    // happy-dom 不实现 submit 按钮的激活行为，直接触发表单 submit 走同一处理入口。
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')).toHaveLength(1);
  });

  it('Enter 发送；Shift+Enter 换行不发送', async () => {
    const wrapper = mountComposer({ modelValue: '第一行' });
    const textarea = wrapper.get('textarea');

    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(wrapper.emitted('submit')).toBeUndefined();

    await textarea.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toHaveLength(1);
  });

  it('IME 组词中的 Enter 不发送', async () => {
    const wrapper = mountComposer({ modelValue: 'ni hao' });

    wrapper.get('textarea').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('附件上传中或失败时禁用发送，全部就绪后恢复', async () => {
    const uploading = mountComposer({
      modelValue: '带附件的消息',
      attachments: [{ localId: 'a1', name: 'note.txt', size: 12, status: 'uploading' }],
    });
    expect(uploading.get('[aria-label="发送"]').attributes('disabled')).toBeDefined();
    await uploading.get('form').trigger('submit');
    expect(uploading.emitted('submit')).toBeUndefined();

    const failed = mountComposer({
      modelValue: '带附件的消息',
      attachments: [{ localId: 'a2', name: 'bad.png', size: 34, status: 'failed', error: '上传失败' }],
    });
    expect(failed.get('[aria-label="发送"]').attributes('disabled')).toBeDefined();

    const ready = mountComposer({
      modelValue: '带附件的消息',
      attachments: [{ localId: 'a3', name: 'ok.png', size: 56, status: 'ready' }],
    });
    expect(ready.get('[aria-label="发送"]').attributes('disabled')).toBeUndefined();
    await ready.get('form').trigger('submit');
    expect(ready.emitted('submit')).toHaveLength(1);
  });

  it('未提供附件能力时不出现附件按钮；附件上传中时附件区可见且不可发送', () => {
    const plain = mountComposer();
    expect(plain.find('[aria-label="添加附件"]').exists()).toBe(false);

    const withAttachment = mountComposer({
      attachments: [{ localId: 'a1', name: 'note.txt', size: 12, status: 'uploading' }],
    });
    expect(withAttachment.find('[aria-label="添加附件"]').exists()).toBe(true);
    expect(withAttachment.text()).toContain('note.txt');
    expect(withAttachment.text()).toContain('上传中…');
  });
});
