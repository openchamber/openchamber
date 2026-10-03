import { mountButton, type ButtonHandle } from './button.ts';
import { el, ensureStyle, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type EmptyProps = {
  title: string;
  body?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
};

export type EmptyHandle = Handle<EmptyProps>;

export const mountEmpty = (root: Element, initial: EmptyProps): EmptyHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const shell = el('div', 'oc-sdk oc-sdk-empty');
  const title = el('h2', 'oc-sdk-empty-title');
  const body = el('p', 'oc-sdk-empty-body');
  const slot = el('div', 'oc-sdk-empty-action');
  shell.append(title, body, slot);
  root.append(shell);
  let action: ButtonHandle | null = null;

  const paint = (): void => {
    setText(title, props.title);
    setText(body, props.body);
    body.hidden = !props.body;
    slot.hidden = !props.action;
    if (!props.action) {
      action?.dispose();
      action = null;
      return;
    }
    const next = { label: props.action.label, onClick: props.action.onClick };
    if (action) {
      action.update(next);
    } else {
      action = mountButton(slot, { ...next, variant: 'outline', size: 'sm' });
    }
  };
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      action?.dispose();
      action = null;
      shell.remove();
    },
  };
};
