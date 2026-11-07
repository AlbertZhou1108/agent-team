import { getCurrentScope, onScopeDispose } from 'vue';

export type PddCleanup = () => void;
export type PddSetup = (element: HTMLElement) => PddCleanup;
export type PddBind = (key: string, element: Element | null | undefined, setup: PddSetup) => void;

type Entry = { element: HTMLElement; cleanup: PddCleanup };

/**
 * 元素节点判定：不用 `instanceof HTMLElement`，因为本模块的用例跑在 node 环境，
 * 那里没有 DOM 全局；nodeType === 1 在浏览器与测试替身上都成立。
 */
function isElementNode(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && (value as Node).nodeType === 1;
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

  const bind: PddBind = (key, element, setup) => {
    if (!isElementNode(element)) {
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
    for (const key of [...entries.keys()]) release(key);
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return { bind, dispose };
}
