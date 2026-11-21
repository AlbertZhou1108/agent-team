import { describe, expect, it } from 'vitest';
import { directiveStatus } from '@/features/messages/directive-status';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

const receipt = (over: Partial<TeamDirectiveReceipt>): TeamDirectiveReceipt => ({
  operationId: 'op-1',
  messageId: 'msg-1',
  seq: 1,
  recipient: '协作助手',
  created: '2026-11-21T12:36:12.000Z',
  status: 'queued',
  error: null,
  ...over,
});

describe('投递回执的展示形态', () => {
  it('排队：中性色，不可点', () => {
    expect(directiveStatus(receipt({ status: 'queued' }))).toEqual({
      label: '已排队',
      tone: 'neutral',
      interactive: false,
    });
  });

  it('已投递且无报错：绿色，不可点', () => {
    expect(directiveStatus(receipt({ status: 'delivered' }))).toEqual({
      label: '已投递',
      tone: 'success',
      interactive: false,
    });
  });

  it('已投递但回合报错：降级为「运行异常」，用琥珀色并允许点开详情', () => {
    const state = directiveStatus(receipt({ status: 'delivered', error: 'QUOTA: Insufficient Balance' }));
    expect(state).toEqual({ label: '运行异常', tone: 'warning', interactive: true });
    // 半失败不能和真正的投递失败共用红色。
    expect(state.tone).not.toBe('danger');
  });

  it('投递失败：唯一使用红色的状态', () => {
    expect(directiveStatus(receipt({ status: 'failed', error: '宿主进程以退出码 1 结束' }))).toEqual({
      label: '投递失败',
      tone: 'danger',
      interactive: true,
    });
  });

  it('待核实：蓝色问号，可点但不等同于失败', () => {
    expect(directiveStatus(receipt({ status: 'unknown' }))).toEqual({
      label: '投递待核实',
      tone: 'info',
      interactive: true,
    });
  });

  it('空报错字符串不触发运行异常', () => {
    expect(directiveStatus(receipt({ status: 'delivered', error: '' }))).toMatchObject({
      label: '已投递',
      tone: 'success',
    });
  });
});
