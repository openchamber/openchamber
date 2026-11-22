import React from 'react';

import { isRightToLeft } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { textareaCaretCoords } from './placement';
import { useInlinePicker, type InlinePicker } from './useInlinePicker';

const typeOver = (field: HTMLTextAreaElement, from: number, to: number, text: string) => {
  field.focus();
  field.setSelectionRange(from, to);
  try {
    if (document.execCommand('insertText', false, text)) return;
  } catch {
    // No such command here; write it directly below.
  }
  // external: https://github.com/facebook/react/blob/main/packages/react-dom-bindings/src/client/inputValueTracking.js The native setter bypasses React's value tracker so the input event reads as a change.
  const next = `${field.value.slice(0, from)}${text}${field.value.slice(to)}`;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, next);
  field.setSelectionRange(from + text.length, from + text.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

export const isPastedInput = (event: Event): boolean => (
  event instanceof InputEvent && /^insertFrom(Paste|Drop)/.test(event.inputType)
);

export function useTextareaInlinePicker(
  fieldRef: React.RefObject<HTMLTextAreaElement | null>,
  pickers: readonly InlinePicker[],
  enabled = true,
): React.ReactNode {
  const [field, setField] = React.useState<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (fieldRef.current !== field) setField(fieldRef.current);
  });

  const { sync, close, handleKeyDown, picker } = useInlinePicker({
    pickers,
    getText: React.useCallback(() => field?.value ?? '', [field]),
    getCaret: React.useCallback(() => field?.selectionStart ?? 0, [field]),
    replaceRange: React.useCallback((from: number, to: number, insert: string) => {
      if (field) typeOver(field, from, to, insert);
    }, [field]),
    caretCoords: React.useCallback((position: number) => (field ? textareaCaretCoords(field, position) : null), [field]),
    getBounds: React.useCallback(() => field?.getBoundingClientRect() ?? null, [field]),
    portalTarget: React.useCallback(() => field?.closest('[data-slot="dialog-content"], [role="dialog"]') ?? null, [field]),
    rightToLeft: field ? isRightToLeft(field) : false,
  });

  React.useEffect(() => {
    if (!field || !enabled) {
      close();
      return;
    }
    const syncAt = (typed: boolean) => {
      if (field.selectionStart === field.selectionEnd) sync(field.value, field.selectionStart, typed);
      else close();
    };
    // external: https://www.w3.org/TR/input-events-2/#input-event-order-during-composition Composition input counts as typing so IME keyboards can open typed-only pickers.
    const onInput = (event: Event) => syncAt(!isPastedInput(event));
    const onCaretMove = () => syncAt(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== field || isIMECompositionEvent(event)) return;
      handleKeyDown(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') onCaretMove();
    };
    field.addEventListener('input', onInput);
    field.addEventListener('keyup', onKeyUp);
    field.addEventListener('click', onCaretMove);
    field.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      field.removeEventListener('input', onInput);
      field.removeEventListener('keyup', onKeyUp);
      field.removeEventListener('click', onCaretMove);
      field.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [close, enabled, field, handleKeyDown, sync]);

  return picker;
}
