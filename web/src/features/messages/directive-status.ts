import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';
export function directiveStatus(receipt: TeamDirectiveReceipt) {
  if (receipt.status === 'delivered') return receipt.error ? '已投递，运行异常' : '已投递';
  if (receipt.status === 'unknown') return '投递待核实';
  return receipt.status === 'failed' ? '投递失败' : '已排队';
}
