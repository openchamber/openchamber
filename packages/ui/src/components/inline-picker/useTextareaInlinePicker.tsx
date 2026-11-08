import React from 'react';

import { isRightToLeft } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { textareaCaretCoords } from './placement';
import { useInlinePicker, type InlinePicker } from './useInlinePicker';

/** Writes `text` over `[from, to)` the way typing would: the field's own change handler and undo see it. */
const typeOver = (field: HTMLTextAreaElement, from: number, to: number, text: string) => {
  field.focus();
  field.setSelectionRange(from, to);
  try {
    if (document.execCommand('insertText', false, text)) return;
  } catch {
    // No such command here; write it directly below.
  }
  // Through the element's own setter, past the one React wraps it in, so the
  // input event reads as a change.
  const next = `${field.value.slice(0, from)}${text}${field.value.slice(to)}`;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, next);
  field.setSelectionRange(from + text.length, from + text.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

/** A paste or a drop brings text the user did not type. */
export const isPastedInput = (event: Event): boolean => (
  event instanceof InputEvent && /^insertFrom(Paste|Drop)/.test(event.inputType)
);

/**
 * `useInlinePicker` wired to a plain textarea without touching its props:
 * native listeners on the element report text and caret changes, and keys are
 * read on the window in the capture phase, before any React handler (the
 * field's, and a panel's that closes on Escape from its capture phase), so an
 * open list takes Enter and Escape for itself. The choice is typed in, so the
 * field's `onChange` and undo see it. Render the returned node beside the field.
 */
export function useTextareaInlinePicker(
  fieldRef: React.RefObject<HTMLTextAreaElement | null>,
  pickers: readonly InlinePicker[],
  enabled = true,
): React.ReactNode {
  const [field, setField] = React.useState<HTMLTextAreaElement | null>(null);

  // The element behind the ref can change between renders (a field that
  // remounts); follow it.
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
    // A modal dialog (Settings too) treats the rest of the page as outside.
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
    // Composing input counts as typing: Android keyboards compose every word.
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
