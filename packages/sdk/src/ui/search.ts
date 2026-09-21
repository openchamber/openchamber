import { button, el, ensureStyle, setAttr, type Handle } from './dom.ts';
import { icon } from './icons.ts';
import { UI_CSS } from './style.ts';

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name. Falls back to the placeholder. */
  label?: string;
  autofocus?: boolean;
};

export type SearchFieldHandle = Handle<SearchFieldProps>;

export const mountSearchField = (root: Element, initial: SearchFieldProps): SearchFieldHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const wrap = el('div', 'oc-sdk oc-sdk-search');
  const input = el('input', 'oc-sdk-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('role', 'searchbox');
  const clear = button('oc-sdk-search-clear');
  clear.append(icon('close', 14));
  clear.tabIndex = -1;
  wrap.append(icon('search', 16, 'oc-sdk-search-icon'), input, clear);
  root.append(wrap);

  const paint = (): void => {
    const placeholder = props.placeholder ?? 'Search';
    setAttr(input, 'placeholder', placeholder);
    input.setAttribute('aria-label', props.label ?? placeholder);
    clear.setAttribute('aria-label', 'Clear search');
    if (input.value !== props.value) {
      input.value = props.value;
    }
    wrap.dataset.active = props.value.trim() === '' ? 'false' : 'true';
  };

  const clearValue = (): void => {
    if (props.value !== '') {
      props.onChange('');
    }
    input.focus();
  };
  const onInput = (): void => {
    props.onChange(input.value);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && input.value !== '') {
      event.preventDefault();
      clearValue();
    }
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  clear.addEventListener('click', clearValue);
  paint();
  if (props.autofocus) {
    input.focus();
  }

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      clear.removeEventListener('click', clearValue);
      wrap.remove();
    },
  };
};
