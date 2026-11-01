import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ toast: vi.fn(() => 'notice'), dismiss: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: Object.assign(mocks.toast, { dismiss: mocks.dismiss }) }));
import { notifyInteraction } from './interaction-notification';

describe('interaction notification navigation', () => {
  it('opens the destination from both notification content and the view action', () => {
    const navigate = vi.fn();
    notifyInteraction('成员甲', '确认卡测试', navigate);
    const [render, options] = mocks.toast.mock.calls.at(-1)! as unknown as [() => { props: { onClick: () => void } }, { duration: number; action: { onClick: () => void } }];
    expect(options.duration).toBe(8000);
    render().props.onClick();
    options.action.onClick();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(mocks.dismiss).toHaveBeenCalledWith('notice');
  });
});
