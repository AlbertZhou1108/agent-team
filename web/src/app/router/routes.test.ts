import { describe, expect, it } from 'vitest';
import { routes } from './routes';

describe('application routes', () => {
  it('opens the assistant for first use and returning users', () => {
    expect(routes[0]).toMatchObject({
      path: '/',
      redirect: '/agent',
    });
  });

  it('keeps the panel agent on its own route', () => {
    expect(routes).toContainEqual(expect.objectContaining({
      path: '/agent',
      name: 'panel-agent',
    }));
  });

  it('uses a dedicated settings page route', () => {
    expect(routes).toContainEqual(expect.objectContaining({
      path: '/settings',
      name: 'settings',
    }));
  });
});
