import { button, ensureStyle, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'default' | 'sm' | 'xs';

export type ButtonProps = {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** Shows a spinner in front of the label and blocks clicks. */
  loading?: boolean;
  onClick: () => void;
};

export type ButtonHandle = Handle<ButtonProps>;

const ring = (): HTMLSpanElement => {
  const spinner = document.createElement('span');
  spinner.className = 'oc-sdk-spinner-ring';
  spinner.setAttribute('aria-hidden', 'true');
  return spinner;
};

export const mountButton = (root: Element, initial: ButtonProps): ButtonHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = button('oc-sdk oc-sdk-btn');
  const spinner = ring();
  const label = document.createElement('span');
  node.append(label);
  root.append(node);

  const paint = (): void => {
    node.dataset.variant = props.variant ?? 'default';
    node.dataset.size = props.size ?? 'default';
    node.disabled = Boolean(props.disabled) || Boolean(props.loading);
    node.dataset.loading = props.loading ? 'true' : 'false';
    node.setAttribute('aria-busy', props.loading ? 'true' : 'false');
    if (props.loading && spinner.parentNode !== node) {
      node.prepend(spinner);
    } else if (!props.loading && spinner.parentNode === node) {
      spinner.remove();
    }
    setText(label, props.label);
  };

  const onClick = (): void => {
    if (props.disabled || props.loading) {
      return;
    }
    props.onClick();
  };
  node.addEventListener('click', onClick);
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      node.removeEventListener('click', onClick);
      node.remove();
    },
  };
};
