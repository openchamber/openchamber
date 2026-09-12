const STYLE_ID = 'oc-sdk-ui-style';

/** Every mount returns this. `update` merges props and repaints; `dispose` removes the node and every listener. */
export type Handle<P> = {
  update: (next: Partial<P>) => void;
  dispose: () => void;
};

export const clearNode = (node: Element): void => {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
};

export const ensureStyle = (css: string): void => {
  const existing = document.getElementById(STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    if (existing.textContent !== css) {
      existing.textContent = css;
    }
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
};

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
};

export const button = (className: string): HTMLButtonElement => {
  const node = el('button', className);
  node.type = 'button';
  return node;
};

/** Writes text only when it changed so a repaint does not disturb selection or layout. */
export const setText = (node: Element, text: string | null | undefined): void => {
  const next = text ?? '';
  if (node.textContent !== next) {
    node.textContent = next;
  }
};

/** Sets or removes an attribute depending on whether a value is present. */
export const setAttr = (node: Element, name: string, value: string | null | undefined): void => {
  if (value === undefined || value === null || value === '') {
    node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
};

/** Runs `handler` on a pointer press outside `node`. Returns the disposer. */
export const onOutsideClick = (node: Element, handler: () => void): (() => void) => {
  const listener = (event: PointerEvent): void => {
    if (event.target instanceof Node && node.contains(event.target)) {
      return;
    }
    handler();
  };
  document.addEventListener('pointerdown', listener, true);
  return () => {
    document.removeEventListener('pointerdown', listener, true);
  };
};
