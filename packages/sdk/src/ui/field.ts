import { el, ensureStyle, setAttr, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type TextFieldProps = {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  password?: boolean;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  /** Error text. Turns the ring red and replaces `helper`. */
  error?: string;
  helper?: string;
  /** Monospace input, for tokens and identifiers. */
  mono?: boolean;
};

export type TextFieldHandle = Handle<TextFieldProps>;

export const mountTextField = (root: Element, initial: TextFieldProps): TextFieldHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const field = el('label', 'oc-sdk oc-sdk-field');
  const caption = el('span', 'oc-sdk-field-label');
  const input = props.multiline ? el('textarea', 'oc-sdk-input') : el('input', 'oc-sdk-input');
  const note = el('span', 'oc-sdk-field-note');
  field.append(caption, input, note);
  root.append(field);

  const paint = (): void => {
    setText(caption, props.label);
    caption.hidden = !props.label;
    if (input instanceof HTMLInputElement) {
      input.type = props.password ? 'password' : 'text';
    } else {
      input.rows = props.rows ?? 3;
    }
    if (input.value !== props.value) {
      input.value = props.value;
    }
    input.disabled = Boolean(props.disabled);
    setAttr(input, 'placeholder', props.placeholder);
    input.dataset.mono = props.mono ? 'true' : 'false';
    const invalid = Boolean(props.error);
    field.dataset.invalid = invalid ? 'true' : 'false';
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    const text = props.error ?? props.helper ?? '';
    setText(note, text);
    note.hidden = text === '';
  };

  const onInput = (): void => {
    props.onChange(input.value);
  };
  input.addEventListener('input', onInput);
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      input.removeEventListener('input', onInput);
      field.remove();
    },
  };
};
