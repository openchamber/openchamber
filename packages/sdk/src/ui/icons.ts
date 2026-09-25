const SVG_NS = 'http://www.w3.org/2000/svg';

/** Remixicon outlines. Add a shape only when a primitive paints it. */
const ICON_PATH = {
  search: 'M18.031 16.617l4.283 4.282-1.415 1.415-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9 9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617zm-2.006-.742A6.977 6.977 0 0 0 18 11c0-3.868-3.133-7-7-7-3.868 0-7 3.132-7 7 0 3.867 3.132 7 7 7a6.977 6.977 0 0 0 4.875-1.975l.15-.15z',
  chevron: 'M12 13.172l4.95-4.95 1.414 1.414L12 16 5.636 9.636 7.05 8.222z',
  check: 'M10 15.172l9.192-9.193 1.415 1.414L10 18l-6.364-6.364 1.414-1.414z',
  close: 'M12 10.586l4.95-4.95 1.414 1.414-4.95 4.95 4.95 4.95-1.414 1.414-4.95-4.95-4.95 4.95-1.414-1.414 4.95-4.95-4.95-4.95L7.05 5.636z',
} as const;

type IconName = keyof typeof ICON_PATH;

export const icon = (name: IconName, size: number, className?: string): SVGSVGElement => {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('fill', 'currentColor');
  if (className) {
    node.setAttribute('class', className);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATH[name]);
  node.append(path);
  return node;
};
