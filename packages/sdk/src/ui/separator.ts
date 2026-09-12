import { el, ensureStyle, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type SeparatorProps = {
  label?: string;
};

export type SeparatorHandle = Handle<SeparatorProps>;

export const mountSeparator = (root: Element, initial: SeparatorProps = {}): SeparatorHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = el('div', 'oc-sdk oc-sdk-separator');
  node.setAttribute('role', 'separator');
  const label = el('span');
  node.append(label);
  root.append(node);

  const paint = (): void => {
    setText(label, props.label);
    label.hidden = !props.label;
    node.dataset.labeled = props.label ? 'true' : 'false';
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
