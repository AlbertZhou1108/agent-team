import { getCurrentScope, onScopeDispose } from 'vue';

export type PddCleanup = () => void;
export type PddSetup = (element: HTMLElement) => PddCleanup;
export type PddBind = (
  key: string,
  element: Element | null | undefined,
  setup: PddSetup,
  previous?: Element | null,
) => void;

type Entry = { element: HTMLElement; cleanup: PddCleanup };

function isElementNode(value: unknown): value is HTMLElement {
  if (typeof value !== 'object' || value === null) return false;
  // 浏览器里只接受真正的 HTMLElement（排除 SVG 等其它 Element）；
  // node 测试环境没有 DOM 全局，退化为 nodeType 判定。
  if (typeof HTMLElement !== 'undefined') return value instanceof HTMLElement;
  return (value as Node).nodeType === 1;
}

/**
 * PDD 元素注册的账本：按 key 记住「元素 → 清理函数」。
 * 同一元素重复回调不重复注册；元素被替换先清理旧的；元素卸载即清理；
 * 组件或作用域销毁时统一清理。
 *
 * 注册什么、清理什么由调用方通过 setup 注入，本模块不 import PDD，
 * 也不参与落点判定或业务动作。
 */
export function usePddBindings() {
  const entries = new Map<string, Entry>();

  function release(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entry.cleanup();
  }

  const bind: PddBind = (key, element, setup, previous) => {
    if (!isElementNode(element)) {
      const entry = entries.get(key);
      if (!entry) return;
      // 旧元素卸载晚于新元素注册时，不能误删新注册；只有登记元素确实是要卸载的那个才释放。
      if (previous && entry.element !== previous) return;
      release(key);
      return;
    }
    const current = entries.get(key);
    if (current?.element === element) return;
    if (current) release(key);
    const cleanup = setup(element);
    entries.set(key, { element, cleanup });
  };

  function dispose() {
    let failed = false;
    let firstError: unknown;
    for (const key of [...entries.keys()]) {
      try {
        release(key);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return { bind, dispose };
}
