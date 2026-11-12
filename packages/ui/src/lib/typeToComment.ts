import { isIMECompositionEvent } from '@/lib/ime';

/**
 * Type-to-comment: while a selection bubble offers Comment, a plain
 * keystroke opens the comment input and becomes its first character.
 * Returns that character, or null when the keystroke belongs to someone
 * else: shortcuts (any modifier but Shift), navigation and editing keys,
 * whitespace (Space still scrolls), dead keys and IME composition, and
 * typing that already goes into an editable field.
 */
export const getTypeToCommentText = (event: KeyboardEvent): string | null => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isIMECompositionEvent(event)) return null;
  // Named keys ("Enter", "ArrowUp", "Dead", "Process") are longer than one
  // code point; a typed character, emoji included, is exactly one.
  if (Array.from(event.key).length !== 1 || /\s/.test(event.key)) return null;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) {
    return null;
  }
  return event.key;
};
