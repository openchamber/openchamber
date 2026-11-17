import { isIMECompositionEvent } from '@/lib/ime';

export const getTypeToCommentText = (event: KeyboardEvent): string | null => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isIMECompositionEvent(event)) return null;
  if (Array.from(event.key).length !== 1 || /\s/.test(event.key)) return null;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) {
    return null;
  }
  return event.key;
};
