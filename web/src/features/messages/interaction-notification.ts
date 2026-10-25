import { h } from 'vue';
import { toast } from 'vue-sonner';

export function notifyInteraction(name: string, text: string, navigate: () => void | Promise<unknown>) {
  const open = () => { void navigate(); toast.dismiss(id); };
  const id = toast(() => h('button', {
    type: 'button',
    class: 'flex w-full flex-col gap-1 text-left focus-visible:outline-2 focus-visible:outline-ring',
    onClick: open,
    'aria-label': `查看互动：${name}，${text}`,
  }, [h('span', { class: 'font-medium' }, `等待你的互动：${name}`), h('span', { class: 'text-sm' }, text)]), {
    duration: Infinity,
    closeButton: true,
    action: { label: '查看', onClick: open },
  });
}
