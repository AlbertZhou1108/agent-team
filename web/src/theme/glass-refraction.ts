import { onMounted, onScopeDispose } from 'vue';
import type { SurfaceRole } from './materials';
import { getAppliedMaterial } from './apply';
import { createRefractionMap } from './refraction-map';

const SVG = 'http://www.w3.org/2000/svg';
const SELECTOR = '[data-surface]';
let nextId = 0;

/** SVG backdrop 位移目前只在已验证的 Chromium 路径启用。
 * CSS.supports 仅证明语法可解析,不能证明 SVG backdrop 真正被执行。
 * 其它引擎保持原有模糊玻璃,不根据语法检测冒充折射支持。
 */
export function supportsGlassRefraction(): boolean {
  return /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent) &&
    CSS.supports('backdrop-filter', 'url("#glass-refraction")');
}

/** 所有表面共用的光学增强:只处理背景,不 filter 前景文字或改变布局。 */
export function startGlassRefraction(): void {
  let dispose = () => {};
  onMounted(() => {
    if (!supportsGlassRefraction()) return;
    const root = document.documentElement;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    svg.dataset.glassFilters = '';
    const defs = document.createElementNS(SVG, 'defs');
    svg.append(defs);
    const entries = new Map<HTMLElement, { filter: SVGFilterElement; signature: string }>();
    const dirty = new Set<HTMLElement>();
    let frame = 0;
    let enabled = false;

    const remove = (element: HTMLElement) => {
      resize.unobserve(element);
      entries.get(element)?.filter.remove();
      entries.delete(element);
      dirty.delete(element);
      element.style.removeProperty('--glass-refraction');
      delete element.dataset.glassRefraction;
    };
    const render = () => {
      frame = 0;
      for (const element of dirty) {
        const entry = entries.get(element);
        if (!entry) continue;
        if (!element.isConnected) { remove(element); continue; }
        const role = element.dataset.surface as SurfaceRole;
        const optics = getAppliedMaterial().roles[role]?.refraction;
        if (!optics) { remove(element); continue; }
        // offset 尺寸不受浮层入场 scale 影响,避免把动画中间帧烘焙进法线图。
        const width = element.offsetWidth, height = element.offsetHeight;
        if (!width || !height) continue;
        const style = getComputedStyle(element);
        const radius = Math.max(...[style.borderTopLeftRadius, style.borderTopRightRadius,
          style.borderBottomLeftRadius, style.borderBottomRightRadius].map(value => Number.parseFloat(value) || 0));
        const signature = `${width}:${height}:${radius}:${role}:${optics.strength}:${optics.edge}:${optics.blur}`;
        if (signature === entry.signature) continue;
        const map = createRefractionMap(width, height, radius, optics.edge);
        const canvas = document.createElement('canvas');
        canvas.width = map.width; canvas.height = map.height;
        const context = canvas.getContext('2d');
        if (!context) continue;
        const image = context.createImageData(map.width, map.height);
        image.data.set(map.data);
        context.putImageData(image, 0, 0);
        const source = document.createElementNS(SVG, 'feImage');
        source.setAttribute('href', canvas.toDataURL());
        source.setAttribute('width', String(width)); source.setAttribute('height', String(height));
        source.setAttribute('preserveAspectRatio', 'none'); source.setAttribute('result', 'lensMap');
        const displacement = document.createElementNS(SVG, 'feDisplacementMap');
        displacement.setAttribute('in', 'SourceGraphic'); displacement.setAttribute('in2', 'lensMap');
        displacement.setAttribute('scale', String(optics.strength));
        displacement.setAttribute('xChannelSelector', 'R'); displacement.setAttribute('yChannelSelector', 'G');
        const blur = document.createElementNS(SVG, 'feGaussianBlur');
        blur.setAttribute('stdDeviation', String(optics.blur));
        entry.filter.setAttribute('width', String(width)); entry.filter.setAttribute('height', String(height));
        entry.filter.replaceChildren(source, displacement, blur);
        element.style.setProperty('--glass-refraction', `url("#${entry.filter.id}") saturate(1.15)`);
        element.dataset.glassRefraction = 'ready';
        entry.signature = signature;
      }
      dirty.clear();
    };
    const schedule = (element: HTMLElement) => {
      dirty.add(element);
      if (!frame) frame = requestAnimationFrame(render);
    };
    const resize = new ResizeObserver(changes => {
      for (const change of changes) schedule(change.target as HTMLElement);
    });
    const add = (element: HTMLElement) => {
      // 控件位于玻璃面板内时沿用父层光学,避免重复折射与嵌套 backdrop root。
      if (element.dataset.surface === 'input' && element.parentElement?.closest(SELECTOR)) return;
      if (entries.has(element) || !getAppliedMaterial().roles[element.dataset.surface as SurfaceRole]?.refraction) return;
      const filter = document.createElementNS(SVG, 'filter');
      filter.id = `glass-refraction-${++nextId}`;
      filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      defs.append(filter);
      entries.set(element, { filter, signature: '' });
      resize.observe(element);
      schedule(element);
    };
    const scan = (node: Element) => {
      if (node instanceof HTMLElement && node.matches(SELECTOR)) add(node);
      for (const element of node.querySelectorAll<HTMLElement>(SELECTOR)) add(element);
    };
    const content = new MutationObserver(changes => {
      if (!enabled) return;
      for (const change of changes) {
        if (change.type === 'attributes' && change.target instanceof HTMLElement) {
          remove(change.target); add(change.target);
        }
        for (const node of change.addedNodes) if (node instanceof Element && node !== svg && !svg.contains(node)) scan(node);
      }
      for (const element of entries.keys()) if (!element.isConnected) remove(element);
    });
    const sync = () => {
      const active = Object.values(getAppliedMaterial().roles).some(finish => !!finish?.refraction);
      if (active !== enabled) {
        enabled = active;
        if (enabled) {
          document.body.append(svg);
          content.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-surface'] });
          scan(document.body);
        } else {
          content.disconnect();
          cancelAnimationFrame(frame); frame = 0;
          for (const element of entries.keys()) remove(element);
          svg.remove();
        }
      } else if (enabled) {
        // 主题/密度修改可能改变圆角,几何签名不变时不重复烘焙。
        for (const element of entries.keys()) schedule(element);
      }
    };
    const environment = new MutationObserver(sync);
    environment.observe(root, { attributes: true, attributeFilter: ['data-material', 'data-density', 'style', 'class'] });
    sync();
    dispose = () => {
      content.disconnect(); environment.disconnect(); resize.disconnect();
      cancelAnimationFrame(frame);
      for (const element of entries.keys()) remove(element);
      svg.remove();
    };
  });
  onScopeDispose(() => dispose());
}
