import { h } from 'vue';
import { toast } from 'vue-sonner';

export function notifyInteraction(name: string, text: string, navigate: () => void | Promise<unknown>) {
  const open = () => { void navigate(); toast.dismiss(id); };
  const id = toast(() => h('button', {
    type: 'button',
    class: 'flex w-full min-w-0 flex-col gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring',
    onClick: open,
    'aria-label': `查看互动：${name}，${text}`,
  }, [h('span', { class: 'font-semibold' }, 'Agent 请求互动'), h('span', { class: 'text-xs text-muted-foreground truncate max-w-full' }, name), h('span', { class: 'text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]' }, text)]), {
    class: 'interaction-notice',
    duration: 8000,
    closeButton: true,
    action: { label: '查看', onClick: open },
  });
}
