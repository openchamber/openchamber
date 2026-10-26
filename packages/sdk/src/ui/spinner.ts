import { el, ensureStyle, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type SpinnerProps = {
  size?: 'sm' | 'default';
  /** Text next to the ring. Also the accessible name. */
  label?: string;
};

export type SpinnerHandle = Handle<SpinnerProps>;

export const mountSpinner = (root: Element, initial: SpinnerProps = {}): SpinnerHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = el('span', 'oc-sdk oc-sdk-spinner');
  node.setAttribute('role', 'status');
  const ring = el('span', 'oc-sdk-spinner-ring');
  ring.setAttribute('aria-hidden', 'true');
  const label = el('span');
  node.append(ring, label);
  root.append(node);

  const paint = (): void => {
    node.dataset.size = props.size ?? 'default';
    setText(label, props.label);
    label.hidden = !props.label;
    node.setAttribute('aria-label', props.label ?? 'Loading');
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
