import { expect, it, vi } from 'vitest';
import { frameBatch } from '@/features/messages/frame-batch';
it('applies a burst once per frame in order and cancels stale events on navigation', () => {
  let run!: () => void;
  const schedule = vi.fn(callback => { run = callback; return 1; });
  const apply = vi.fn();
  const batch = frameBatch(apply, schedule, vi.fn());
  for (let i = 0; i < 100; i++) batch.push(i);
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  run();
  expect(apply.mock.calls.map(([value]) => value)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  batch.push('stale');
  batch.dispose();
  batch.flush();
  expect(apply).toHaveBeenCalledTimes(100);
});
