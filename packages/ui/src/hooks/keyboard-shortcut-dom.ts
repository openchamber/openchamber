const OPEN_DROPDOWN_SELECTOR = [
  '[data-slot="dropdown-menu-content"][data-open]',
  '[data-slot="select-content"][data-open]',
].join(',');

export function hasOpenDropdown(root: ParentNode = document): boolean {
  return Boolean(root.querySelector(OPEN_DROPDOWN_SELECTOR));
}

export function shouldStopDropdownImeEscape(
  event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>,
  dropdownOpen: boolean,
): boolean {
  return dropdownOpen
    && event.key === 'Escape'
    && (event.isComposing || event.keyCode === 229);
}
