import { onMounted, onScopeDispose } from 'vue';
import { motionPace, prefersReducedMotion } from '@/shared/motion';

const SURFACE = '[data-surface="nav-panel"], [data-surface="context-panel"], [data-surface="action"], [data-surface="overlay"]';
const LIGHT_PROPERTIES = ['--glass-x', '--glass-y', '--glass-energy'];

/** 局部受光随交互有阻尼地移动;仅玻璃开启,收敛后停帧,卸载/切材质清理。 */
export function startGlassLighting(): void {
  let dispose = () => {};
  onMounted(() => {
    const root = document.documentElement;
    const surfaces = new Map<HTMLElement, {
      x: number; y: number; energy: number;
      targetX: number; targetY: number; targetEnergy: number;
    }>();
    let frame = 0;
    let previousTime = 0;
    let enabled = false;
    let pace = 1;
    let current: HTMLElement | null = null;

    const clearSurface = (element: HTMLElement) => {
      for (const property of LIGHT_PROPERTIES) element.style.removeProperty(property);
      surfaces.delete(element);
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      current = null;
      for (const element of surfaces.keys()) clearSurface(element);
    };
    const tick = (time: number) => {
      frame = 0;
      const elapsed = previousTime ? Math.min(time - previousTime, 64) : 16;
      previousTime = time;
      const follow = 1 - Math.exp(-elapsed / (90 * pace));
      let unsettled = false;
      for (const [element, light] of surfaces) {
        if (!element.isConnected) { clearSurface(element); continue; }
        light.x += (light.targetX - light.x) * follow;
        light.y += (light.targetY - light.y) * follow;
        light.energy += (light.targetEnergy - light.energy) * follow;
        const moving = Math.abs(light.targetX - light.x) > 0.05 ||
          Math.abs(light.targetY - light.y) > 0.05 ||
          Math.abs(light.targetEnergy - light.energy) > 0.002;
        if (!moving && light.targetEnergy === 0) { clearSurface(element); continue; }
        element.style.setProperty('--glass-x', `${light.x.toFixed(2)}%`);
        element.style.setProperty('--glass-y', `${light.y.toFixed(2)}%`);
        element.style.setProperty('--glass-energy', light.energy.toFixed(3));
        unsettled ||= moving;
      }
      if (unsettled) frame = requestAnimationFrame(tick);
      else previousTime = 0;
    };
    const wake = () => { if (!frame) frame = requestAnimationFrame(tick); };
    const leave = () => {
      current = null;
      for (const light of surfaces.values()) light.targetEnergy = 0;
      if (surfaces.size) wake();
    };
    const illuminate = (event: PointerEvent, energy: number) => {
      if (!enabled) return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(SURFACE) : null;
      if (!element) { leave(); return; }
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (current !== element) leave();
      current = element;
      const x = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100));
      const y = Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100));
      const light = surfaces.get(element) ?? { x, y, energy: 0, targetX: x, targetY: y, targetEnergy: 0 };
      light.targetX = x;
      light.targetY = y;
      light.targetEnergy = energy;
      surfaces.set(element, light);
      wake();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') illuminate(event, event.buttons ? 1 : 0.65);
    };
    const down = (event: PointerEvent) => illuminate(event, 1);
    const up = (event: PointerEvent) => {
      if (event.pointerType === 'touch') leave();
      else illuminate(event, 0.65);
    };
    const visibility = () => { if (document.hidden) reset(); };
    const sync = () => {
      enabled = root.dataset.materialEffect === 'glass' && !prefersReducedMotion();
      pace = motionPace();
      if (!enabled) reset();
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-material', 'data-material-effect', 'data-motion'] });
    sync();
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerdown', down, { passive: true });
    document.addEventListener('pointerup', up, { passive: true });
    document.addEventListener('pointercancel', leave, { passive: true });
    document.addEventListener('pointerleave', leave, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', leave);
    dispose = () => {
      reset();
      observer.disconnect();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', leave);
      document.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', leave);
    };
  });
  onScopeDispose(() => dispose());
}
