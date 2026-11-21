// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageReceipt from '@/features/messages/MessageReceipt.vue';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

const receipt = (over: Partial<TeamDirectiveReceipt> = {}): TeamDirectiveReceipt => ({
  operationId: 'op-1',
  messageId: 'msg-1',
  seq: 1,
  recipient: '协作助手',
  created: '2026-11-21T12:36:12.000Z',
  status: 'failed',
  error: 'dsh 退出 (1)：QUOTA: Insufficient Balance',
  ...over,
});

describe('投递回执标签', () => {
  it('可点状态渲染成按钮，并带可读的完整名称', () => {
    const wrapper = mount(MessageReceipt, { props: { receipt: receipt() } });
    const button = wrapper.get('button.message-receipt-tag');
    expect(button.attributes('aria-label')).toBe('投递失败，查看详情');
    expect(button.attributes('data-interactive')).toBeDefined();
    expect(button.text()).toContain('投递失败');
  });

  it('可点标签只留状态图标，不挂箭头：可点由 hover 展开与光标表达', () => {
    const wrapper = mount(MessageReceipt, { props: { receipt: receipt() } });
    expect(wrapper.get('button.message-receipt-tag').findAll('svg')).toHaveLength(1);
  });

  it('点标签把回执抛给上层，由上层打开唯一的详情弹窗', async () => {
    const wrapper = mount(MessageReceipt, { props: { receipt: receipt() } });
    await wrapper.get('button').trigger('click');
    const events = wrapper.emitted('open');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.[0]).toMatchObject({ messageId: 'msg-1', status: 'failed' });
  });

  it('不可点状态不进 Tab 序列：渲染成 span 而不是按钮', () => {
    const wrapper = mount(MessageReceipt, {
      props: { receipt: receipt({ status: 'delivered', error: null }) },
    });
    expect(wrapper.find('button').exists()).toBe(false);
    const tag = wrapper.get('.message-receipt-tag');
    expect(tag.attributes('data-static')).toBeDefined();
    expect(tag.text()).toContain('已投递');
  });

  it('不可点的标签与可点的长得一样：同样收起，靠 hover 展开文字', () => {
    const wrapper = mount(MessageReceipt, {
      props: { receipt: receipt({ status: 'delivered', error: null }) },
    });
    const tag = wrapper.get('.message-receipt-tag');
    // 文字留在 DOM 里（读屏与 hover 展开都要用它），收起只由 CSS 的 grid 轨道控制。
    expect(tag.find('.receipt-extra').exists()).toBe(true);
    expect(tag.get('.receipt-label').text()).toBe('已投递');
    expect(tag.attributes('aria-label')).toBeUndefined();
  });

  it('点不可点的标签不会打开任何东西', async () => {
    const wrapper = mount(MessageReceipt, {
      props: { receipt: receipt({ status: 'queued', error: null }) },
    });
    await wrapper.get('.message-receipt-tag').trigger('click');
    expect(wrapper.emitted('open')).toBeUndefined();
  });

  it('已排队与已投递都不提供详情入口', () => {
    for (const status of ['queued', 'delivered'] as const) {
      const wrapper = mount(MessageReceipt, { props: { receipt: receipt({ status, error: null }) } });
      expect(wrapper.find('button').exists()).toBe(false);
    }
  });

  it('三种语气各自带上颜色标记，只有真失败用 danger', () => {
    const toneOf = (over: Partial<TeamDirectiveReceipt>) =>
      mount(MessageReceipt, { props: { receipt: receipt(over) } })
        .get('.message-receipt-tag')
        .attributes('data-tone');

    expect(toneOf({ status: 'failed' })).toBe('danger');
    expect(toneOf({ status: 'delivered', error: 'boom' })).toBe('warning');
    expect(toneOf({ status: 'unknown' })).toBe('info');
    expect(toneOf({ status: 'queued', error: null })).toBe('neutral');
    expect(toneOf({ status: 'delivered', error: null })).toBe('success');
  });

  it('用户发言的回执跟随气泡靠右', () => {
    const wrapper = mount(MessageReceipt, { props: { receipt: receipt(), align: 'end' } });
    expect(wrapper.get('.message-receipt').classes()).toContain('message-receipt--end');
  });
});
