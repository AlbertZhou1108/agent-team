import { readonly, ref } from 'vue';

const now = ref(new Date());

let started = false;

function tick() {
  now.value = new Date();
  // 递归 setTimeout 而非 setInterval：每次按当前时刻重新对齐到下一个整分，
  // 页面休眠唤醒后不会带着累计漂移继续跳。
  const delay = 60_000 - (Date.now() % 60_000);
  setTimeout(tick, delay);
}

/**
 * 提供"当前时刻"的响应式快照，按分钟刷新。
 *
 * 时间文案要判断"是不是今天"，而页面可能整夜开着：只在挂载时算一次，
 * 跨过午夜后昨天的消息会一直被当成今天。全站共享一个计时器，不按消息条数起。
 */
export function useNowMinute() {
  if (!started) {
    started = true;
    setTimeout(tick, 60_000 - (Date.now() % 60_000));
    // 休眠恢复时不等到下一个整分，立刻纠正一次。
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) now.value = new Date();
      });
    }
  }
  return readonly(now);
}
