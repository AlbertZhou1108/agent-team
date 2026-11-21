import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

/** 回执的视觉语气。只有 danger 用红：红是"需要你动手"的信号，用滥就不值钱。 */
export type ReceiptTone = 'neutral' | 'success' | 'warning' | 'info' | 'danger';

export interface DirectiveStatus {
  label: string;
  tone: ReceiptTone;
  /** 可点：能打开投递详情弹窗。 */
  interactive: boolean;
}

/**
 * 回执状态到展示形态的唯一映射。
 *
 * 后端 status 只有四个取值，`delivered + error` 是被前端派生的第五种：
 * 消息送到了，但这一回合执行时报错，属于半失败，不能和真正的投递失败共用红色。
 */
export function directiveStatus(receipt: TeamDirectiveReceipt): DirectiveStatus {
  switch (receipt.status) {
    case 'queued':
      return { label: '已排队', tone: 'neutral', interactive: false };
    case 'delivered':
      return receipt.error
        ? { label: '运行异常', tone: 'warning', interactive: true }
        : { label: '已投递', tone: 'success', interactive: false };
    case 'failed':
      return { label: '投递失败', tone: 'danger', interactive: true };
    default:
      return { label: '投递待核实', tone: 'info', interactive: true };
  }
}
