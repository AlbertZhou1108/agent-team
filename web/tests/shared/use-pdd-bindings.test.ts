import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { usePddBindings, type PddBind } from '@/shared/use-pdd-bindings';

function fakeElement(): HTMLElement {
  return { nodeType: 1 } as unknown as HTMLElement;
}

function setupSpy() {
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const setup = vi.fn((_element: HTMLElement) => {
    const cleanup = vi.fn();
    cleanups.push(cleanup);
    return cleanup;
  });
  return { setup, cleanups };
}

describe('pdd 元素绑定账本', () => {
  it('首次绑定调用一次 setup，且传入的就是该元素', () => {
    const { bind } = usePddBindings();
    const { setup } = setupSpy();
    const element = fakeElement();
    bind('a', element, setup);
    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(element);
  });

  it('卸载后同一元素重新挂载会重新 setup', () => {
    const { bind } = usePddBindings();
    const { setup } = setupSpy();
    const element = fakeElement();
    bind('a', element, setup);
    bind('a', null, setup);
    bind('a', element, setup);
    expect(setup).toHaveBeenCalledTimes(2);
  });

  it('某个 cleanup 抛错时仍清理其余条目，并抛出首个错误', () => {
    const { bind, dispose } = usePddBindings();
    const later = vi.fn();
    bind('a', fakeElement(), () => () => {
      throw new Error('cleanup boom');
    });
    bind('b', fakeElement(), () => later);
    expect(() => dispose()).toThrow('cleanup boom');
    expect(later).toHaveBeenCalledOnce();
  });

  it('同一 key 同一元素重复回调不重复注册', () => {
    const { bind } = usePddBindings();
    const { setup } = setupSpy();
    const element = fakeElement();
    bind('a', element, setup);
    bind('a', element, setup);
    bind('a', element, setup);
    expect(setup).toHaveBeenCalledOnce();
  });

  it('元素被替换时先清理旧的再注册新的', () => {
    const { bind } = usePddBindings();
    const order: string[] = [];
    let index = 0;
    const setup = vi.fn((_element: HTMLElement) => {
      index += 1;
      const tag = index;
      order.push(`setup${tag}`);
      return () => order.push(`cleanup${tag}`);
    });
    bind('a', fakeElement(), setup);
    bind('a', fakeElement(), setup);
    expect(order).toEqual(['setup1', 'cleanup1', 'setup2']);
  });

  it('判重按元素而不是按 setup 身份', () => {
    const { bind } = usePddBindings();
    const element = fakeElement();
    const first = setupSpy();
    const second = setupSpy();
    bind('a', element, first.setup);
    bind('a', element, second.setup);
    expect(first.setup).toHaveBeenCalledOnce();
    expect(second.setup).not.toHaveBeenCalled();
  });

  it('替换元素时新 setup 抛错：旧注册已清理，key 不保留', () => {
    const { bind } = usePddBindings();
    const first = setupSpy();
    const element = fakeElement();
    bind('a', element, first.setup);
    expect(() => bind('a', fakeElement(), () => {
      throw new Error('boom');
    })).toThrow('boom');
    expect(first.cleanups[0]).toHaveBeenCalledOnce();

    const retry = setupSpy();
    bind('a', element, retry.setup);
    expect(retry.setup).toHaveBeenCalledOnce();
  });

  it('元素卸载（null）时清理，重复 null 不重复清理', () => {
    const { bind } = usePddBindings();
    const { setup, cleanups } = setupSpy();
    bind('a', fakeElement(), setup);
    bind('a', null, setup);
    bind('a', undefined, setup);
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
  });

  it('非元素值不注册；已有注册时会被清理', () => {
    const { bind } = usePddBindings();
    const { setup, cleanups } = setupSpy();
    bind('a', {} as unknown as Element, setup);
    bind('a', { nodeType: 3 } as unknown as Element, setup);
    expect(setup).not.toHaveBeenCalled();

    bind('b', fakeElement(), setup);
    bind('b', {} as unknown as Element, setup);
    expect(cleanups[0]).toHaveBeenCalledOnce();
  });

  it('dispose 清理全部注册，重复调用不重复清理', () => {
    const { bind, dispose } = usePddBindings();
    const { setup, cleanups } = setupSpy();
    bind('a', fakeElement(), setup);
    bind('b', fakeElement(), setup);
    dispose();
    dispose();
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(cleanups[1]).toHaveBeenCalledOnce();
  });

  it('不同 key 互不影响', () => {
    const { bind, dispose } = usePddBindings();
    const { setup, cleanups } = setupSpy();
    bind('a', fakeElement(), setup);
    bind('b', fakeElement(), setup);
    bind('a', null, setup);
    expect(cleanups[0]).toHaveBeenCalledOnce();
    expect(cleanups[1]).not.toHaveBeenCalled();
    dispose();
    expect(cleanups[1]).toHaveBeenCalledOnce();
  });

  it('setup 抛错时不写入注册表，异常向上抛', () => {
    const { bind } = usePddBindings();
    const element = fakeElement();
    expect(() => bind('a', element, () => { throw new Error('boom'); })).toThrow('boom');

    const { setup } = setupSpy();
    bind('a', element, setup);
    expect(setup).toHaveBeenCalledOnce();
  });

  it('所在作用域销毁时自动清理', async () => {
    const { setup, cleanups } = setupSpy();
    const scope = effectScope();
    scope.run(() => {
      const { bind } = usePddBindings();
      bind('a', fakeElement(), setup);
    });
    await nextTick();
    expect(cleanups[0]).not.toHaveBeenCalled();
    scope.stop();
    expect(cleanups[0]).toHaveBeenCalledOnce();
  });

  it('旧元素晚到的卸载回调不会误删新注册', () => {
    const { bind } = usePddBindings();
    const { setup } = setupSpy();
    const first = fakeElement();
    const second = fakeElement();
    bind('a', first, setup);
    bind('a', second, setup);
    bind('a', null, setup, first);

    const probe = setupSpy();
    bind('a', second, probe.setup);
    expect(probe.setup).not.toHaveBeenCalled();
  });

  it('卸载回调携带的元素与当前登记一致时才释放', () => {
    const { bind } = usePddBindings();
    const { setup, cleanups } = setupSpy();
    const element = fakeElement();
    bind('a', element, setup);
    bind('a', null, setup, fakeElement());
    expect(cleanups[0]).not.toHaveBeenCalled();
    bind('a', null, setup, element);
    expect(cleanups[0]).toHaveBeenCalledOnce();
  });
});

describe('pdd 绑定类型', () => {
  it('bind 签名接受 null 与 undefined 元素', () => {
    const bind: PddBind = () => {};
    bind('a', null, () => () => {});
    bind('a', undefined, () => () => {});
  });
});
