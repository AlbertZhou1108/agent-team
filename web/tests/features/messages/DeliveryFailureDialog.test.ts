// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeliveryFailureDialog from '@/features/messages/DeliveryFailureDialog.vue';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

const receipt = (over: Partial<TeamDirectiveReceipt> = {}): TeamDirectiveReceipt => ({
  operationId: 'op-1',
  messageId: 'msg-1',
  seq: 1,
  recipient: '协作助手',
  created: new Date(2026, 10, 21, 18, 7, 48).toISOString(),
  status: 'failed',
  error: 'dsh 退出 (1)\nQUOTA: Insufficient Balance',
  ...over,
});

// 弹窗走 Teleport 到 body，内容不在 wrapper 内；每个用例先等一帧再读，结束清干净。
async function open(over: Partial<TeamDirectiveReceipt> = {}) {
  const wrapper = mount(DeliveryFailureDialog, {
    props: { open: true, receipt: receipt(over) },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

const bodyText = () => document.body.textContent ?? '';
const footerLabels = () =>
  [...document.querySelectorAll('[data-slot="dialog-footer"] button')].map(b =>
    b.textContent?.trim(),
  );

afterEach(() => {
  document.body.innerHTML = '';
});

describe('投递详情弹窗', () => {
  it('展示标题、去向与完整报错原文', async () => {
    const wrapper = await open();
    expect(bodyText()).toContain('投递失败');
    expect(bodyText()).toContain('发给「协作助手」的消息没有送达');
    // 原文一字不改地给出来，用户要能整段拷走。
    expect(document.querySelector('pre')?.textContent).toContain('QUOTA: Insufficient Balance');
    wrapper.unmount();
  });

  it('回执只带 id 时用消息流补出的接收者名，不把 UUID 当人名', async () => {
    const id = 'f2259358-8ed7-4d46-838a-86afa38bf5d1';
    const wrapper = await open({ recipient: id, recipientName: '主 Agent' });
    expect(bodyText()).toContain('发给「主 Agent」的消息没有送达');
    expect(bodyText()).not.toContain(id);
    wrapper.unmount();
  });

  it('名字缺失时退成「成员」，也不露 id', async () => {
    const id = 'f2259358-8ed7-4d46-838a-86afa38bf5d1';
    const wrapper = await open({ recipient: id });
    expect(bodyText()).toContain('发给「成员」的消息没有送达');
    expect(bodyText()).not.toContain(id);
    wrapper.unmount();
  });

  it('当天的回执时间只显示时分秒', async () => {
    const today = new Date();
    const wrapper = await open({
      created: new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        5,
        36,
        12,
      ).toISOString(),
    });
    const time = document.querySelector('time');
    expect(time?.textContent?.trim()).toBe('05:36:12');
    expect(time?.getAttribute('datetime')).toBeTruthy();
    wrapper.unmount();
  });

  it('跨天的回执时间补全年月日', async () => {
    const wrapper = await open({ created: new Date(2026, 0, 3, 9, 8, 7).toISOString() });
    expect(document.querySelector('time')?.textContent?.trim()).toBe('2026-01-03 09:08:07');
    wrapper.unmount();
  });

  it('只说系统不会自动重试，不给按错误类型猜出来的行动指引', async () => {
    const wrapper = await open();
    expect(bodyText()).toContain('系统不会自动重试');
    // /retry 只在命令行可用，网页端无处执行，不能出现在弹窗里钓鱼。
    expect(bodyText()).not.toContain('/retry');
    wrapper.unmount();
  });

  it('运行异常与待核实各有自己的标题和说明', async () => {
    const warning = await open({ status: 'delivered', error: 'boom' });
    expect(bodyText()).toContain('运行异常');
    expect(bodyText()).toContain('消息已送达');
    warning.unmount();

    const info = await open({ status: 'unknown', error: null });
    expect(bodyText()).toContain('投递待核实');
    expect(bodyText()).toContain('请核实是否已处理');
    expect(bodyText()).not.toContain('/retry');
    info.unmount();
  });

  it('没有原始报错时不给「复制报错」，只留关闭', async () => {
    const wrapper = await open({ status: 'unknown', error: null });
    expect(footerLabels()).toEqual(['关闭']);
    wrapper.unmount();
  });

  it('有原始报错时提供复制入口', async () => {
    const wrapper = await open();
    expect(footerLabels()).toEqual(['关闭', '复制报错']);
    wrapper.unmount();
  });

  it('关闭按钮把 open 置回 false', async () => {
    const wrapper = await open();
    const close = [...document.querySelectorAll('[data-slot="dialog-footer"] button')].find(
      b => b.textContent?.trim() === '关闭',
    ) as HTMLButtonElement;
    close.click();
    await flushPromises();
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
    wrapper.unmount();
  });
});
