import type React from 'react';
import { isIMECompositionEvent } from '@/lib/ime';

/** Save through the form's existing submit handler, without relying on keypress. */
export function handleSessionRenameKeyDown(event: React.KeyboardEvent<HTMLInputElement>, cancel: () => void): void {
  event.stopPropagation();
  if (isIMECompositionEvent(event)) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!event.repeat) event.currentTarget.form?.requestSubmit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
}
