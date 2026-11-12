import { mountButton, type ButtonHandle } from './button.ts';
import { el, ensureStyle, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type BannerTone = 'info' | 'success' | 'warning' | 'error';

export type BannerProps = {
  tone: BannerTone;
  title: string;
  body?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
};

export type BannerHandle = Handle<BannerProps>;

export const mountBanner = (root: Element, initial: BannerProps): BannerHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = el('div', 'oc-sdk oc-sdk-banner');
  const text = el('div', 'oc-sdk-banner-text');
  const title = el('div', 'oc-sdk-banner-title');
  const body = el('div', 'oc-sdk-banner-body');
  const slot = el('div', 'oc-sdk-banner-action');
  text.append(title, body);
  node.append(text, slot);
  root.append(node);
  let action: ButtonHandle | null = null;

  const paint = (): void => {
    node.dataset.tone = props.tone;
    node.setAttribute('role', props.tone === 'error' || props.tone === 'warning' ? 'alert' : 'status');
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
      action = mountButton(slot, { ...next, variant: 'outline', size: 'xs' });
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
      node.remove();
    },
  };
};
