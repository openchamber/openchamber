import { el, ensureStyle, setAttr, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info';

export type BadgeProps = {
  label: string;
  tone?: Tone;
};

export type BadgeHandle = Handle<BadgeProps>;

/** Writes `data-tone` for toned colours; neutral removes it. */
export const applyTone = (node: Element, tone: Tone | undefined): void => {
  setAttr(node, 'data-tone', tone && tone !== 'neutral' ? tone : null);
};

export const mountBadge = (root: Element, initial: BadgeProps): BadgeHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = el('span', 'oc-sdk oc-sdk-badge');
  root.append(node);

  const paint = (): void => {
    setText(node, props.label);
    applyTone(node, props.tone);
  };
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      node.remove();
    },
  };
};
