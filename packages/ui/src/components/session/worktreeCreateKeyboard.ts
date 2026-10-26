import type React from 'react';
import { isIMECompositionEvent } from '@/lib/ime';

/** Trigger the dialog's main action from a text field without relying on a native form submit. */
export function handleWorktreeCreateKeyDown(event: React.KeyboardEvent<HTMLInputElement>, submit: () => void): void {
  if (event.key !== 'Enter' || isIMECompositionEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) submit();
}
