// 测试共用的等待原语。
// 轮询而不是监听:多数场景等的是"宿主回合结束""投递完成"这类复合状态,没有单一事件可听。
export const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * 轮询直到条件成立。默认 5 秒预算:够跑完一次 fake 回合,
 * 又能在真出问题时快速失败,不把整套测试拖成十几秒。
 */
export async function until(fn, message = 'condition timed out', budgetMs = 5000) {
  const end = Date.now() + budgetMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
