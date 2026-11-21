const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * 接收者显示名。
 *
 * 回执接口只给接收者 id，名字由消息流按同一个 id 补（见 MessageFeed.openReceipt）；
 * 两个来源都可能缺。兜底成「成员」——宁可说不清是谁，也不能把 UUID 当成名字
 * 摆在用户面前（历史数据、消息未加载时都会走到这里）。
 */
export function recipientLabel(receipt: {
  recipient: string;
  recipientName?: string | null;
}): string {
  const name = receipt.recipientName?.trim();
  if (name) return name;
  const raw = receipt.recipient?.trim();
  if (raw && !UUID.test(raw)) return raw;
  return '成员';
}
