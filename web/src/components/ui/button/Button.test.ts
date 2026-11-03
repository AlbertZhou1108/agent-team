import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import Button from './Button.vue';

function renderButton(props: Record<string, unknown>) {
  return renderToString(createSSRApp(Button, props));
}

describe('Button element contract', () => {
  it('always exposes the effective variant, including the default', async () => {
    const html = await renderButton({});
    expect(html).toContain('data-variant="default"');
  });
  it('keeps the explicit variant on the rendered element', async () => {
    const html = await renderButton({ variant: 'outline' });
    expect(html).toContain('data-variant="outline"');
  });
});
