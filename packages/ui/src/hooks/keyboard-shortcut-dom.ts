import { isIMECompositionEvent } from '../lib/ime';

const OPEN_DROPDOWN_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-open]',
  '[data-slot="select-content"][data-open]',
].join(',');

export function hasOpenDropdown(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(OPEN_DROPDOWN_SELECTOR));
}

export function hasActiveBtwComposer(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[data-btw-composer="true"]'));
}

export function shouldStopDropdownImeEscape(
  event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>,
  dropdownOpen: boolean,
): boolean {
  return dropdownOpen
    && event.key === 'Escape'
    && (event.isComposing || event.keyCode === 229);
}

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

export function canUseDigitShortcut(event: KeyboardEvent): boolean {
  if (isIMECompositionEvent(event)) return false;
  if (!isEditableEventTarget(event.target)) return true;
  return (event.metaKey || event.ctrlKey) && !event.getModifierState('AltGraph');
}

export function typesOutsidePrefixField(event: KeyboardEvent, prefixTarget: EventTarget | null): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || !isEditableEventTarget(event.target)) return false;
  if (prefixTarget === event.target) return false;
  return !(prefixTarget instanceof HTMLElement) || prefixTarget.isConnected;
}
