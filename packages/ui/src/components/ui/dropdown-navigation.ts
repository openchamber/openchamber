import type React from 'react';

import { isIMECompositionEvent } from '@/lib/ime';

export function getDropdownNavigationKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): 'ArrowDown' | 'ArrowUp' | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.key.toLowerCase() === 'n' || event.code === 'KeyN') return 'ArrowDown';
  if (event.key.toLowerCase() === 'p' || event.code === 'KeyP') return 'ArrowUp';
  return null;
}

type DropdownNavigationEvent = Pick<
  React.KeyboardEvent<HTMLElement>,
  | 'altKey'
  | 'code'
  | 'ctrlKey'
  | 'defaultPrevented'
  | 'isPropagationStopped'
  | 'key'
  | 'metaKey'
  | 'preventDefault'
  | 'shiftKey'
  | 'stopPropagation'
>;

export function handleDropdownNavigationKey(
  event: DropdownNavigationEvent,
  navigate: (key: 'ArrowDown' | 'ArrowUp') => void,
): boolean {
  if (event.defaultPrevented || event.isPropagationStopped()) return false;
  const navigationKey = getDropdownNavigationKey(event);
  if (!navigationKey) return false;

  navigate(navigationKey);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function shouldDismissDropdown(
  event: KeyboardEvent | React.KeyboardEvent,
): boolean {
  return event.key === 'Escape' && !isIMECompositionEvent(event);
}
