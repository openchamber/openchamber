import { button, clearNode, el, ensureStyle, setText, type Handle } from './dom.ts';
import { icon } from './icons.ts';
import { moveListSelection, navigationKey } from './navigation.ts';
import { createOption, highlightOption } from './option.ts';
import { openPopup } from './popup.ts';
import { UI_CSS } from './style.ts';

export type SelectOption = {
  id: string;
  label: string;
  /** Small muted text at the right of the option. */
  hint?: string;
};

export type SelectProps = {
  label?: string;
  value: string | null;
  options: SelectOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  /** Adds a search box at the top of the popup. */
  searchable?: boolean;
  searchPlaceholder?: string;
  disabled?: boolean;
};

export type SelectHandle = Handle<SelectProps>;

/** Case-insensitive substring match on label and id. Empty query keeps every option. */
export const filterSelectOptions = (options: readonly SelectOption[], query: string): SelectOption[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...options];
  }
  return options.filter((option) => (
    option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle)
  ));
};

let selectCount = 0;

export const mountSelect = (root: Element, initial: SelectProps): SelectHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const uid = `oc-sdk-select-${selectCount += 1}`;
  const wrap = el('div', 'oc-sdk oc-sdk-select');
  const caption = el('span', 'oc-sdk-field-label');
  caption.id = `${uid}-label`;
  const trigger = button('oc-sdk-trigger');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-labelledby', caption.id);
  const value = el('span', 'oc-sdk-trigger-value');
  trigger.append(value, icon('chevron', 14, 'oc-sdk-trigger-chevron'));
  wrap.append(caption, trigger);
  root.append(wrap);

  let query = '';
  let activeId: string | null = null;
  let closePopup: (() => void) | null = null;
  const popup = el('div', 'oc-sdk oc-sdk-popup');
  const searchSlot = el('div', 'oc-sdk-popup-search');
  const search = el('input', 'oc-sdk-input');
  search.type = 'text';
  search.autocomplete = 'off';
  searchSlot.append(search);
  const listbox = el('div');
  listbox.setAttribute('role', 'listbox');
  listbox.tabIndex = -1;
  popup.append(listbox);

  const visible = (): SelectOption[] => filterSelectOptions(props.options, props.searchable ? query : '');
  const focusOwner = (): HTMLElement => (props.searchable ? search : listbox);
  const setActive = (id: string | null): void => {
    activeId = id;
    highlightOption(listbox, focusOwner(), uid, id);
  };

  const paintOptions = (): void => {
    clearNode(listbox);
    const options = visible();
    if (options.length === 0) {
      const empty = el('div', 'oc-sdk-popup-empty');
      empty.textContent = 'No matches';
      listbox.append(empty);
    }
    for (const option of options) {
      listbox.append(createOption(uid, 'option', { ...option, selected: option.id === props.value }, {
        hover: () => setActive(option.id),
        pick: () => pick(option.id),
      }));
    }
    setActive(options.some((option) => option.id === activeId) ? activeId : options[0]?.id ?? null);
  };

  const close = (): void => {
    closePopup?.();
    closePopup = null;
    query = '';
    search.value = '';
    trigger.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    if (closePopup || props.disabled) {
      return;
    }
    activeId = props.value;
    search.placeholder = props.searchPlaceholder ?? 'Search';
    if (props.searchable) popup.prepend(searchSlot); else searchSlot.remove();
    paintOptions();
    closePopup = openPopup(wrap, trigger, popup, close);
    trigger.setAttribute('aria-expanded', 'true');
    focusOwner().focus();
  };
  const pick = (id: string): void => {
    close();
    trigger.focus();
    if (id !== props.value) props.onChange(id);
  };

  const onTriggerClick = (): void => {
    if (closePopup) close(); else open();
  };
  const onTriggerKey = (event: KeyboardEvent): void => {
    if (!closePopup && navigationKey(event)) {
      event.preventDefault();
      open();
    }
  };
  const onPopupKey = (event: KeyboardEvent): void => {
    const step = navigationKey(event);
    if (step) {
      event.preventDefault();
      setActive(moveListSelection(visible(), activeId, step));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeId) pick(activeId);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      trigger.focus();
    } else if (props.searchable && event.target !== search && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      search.focus();
    }
  };
  const onSearchInput = (): void => {
    query = search.value;
    paintOptions();
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (closePopup && !(event.relatedTarget instanceof Node && wrap.contains(event.relatedTarget))) close();
  };

  const paint = (): void => {
    setText(caption, props.label);
    caption.hidden = !props.label;
    const current = props.options.find((option) => option.id === props.value);
    setText(value, current?.label ?? props.placeholder ?? 'Select');
    value.dataset.empty = current ? 'false' : 'true';
    trigger.disabled = Boolean(props.disabled);
    if (closePopup) paintOptions();
  };

  trigger.addEventListener('click', onTriggerClick);
  trigger.addEventListener('keydown', onTriggerKey);
  popup.addEventListener('keydown', onPopupKey);
  search.addEventListener('input', onSearchInput);
  wrap.addEventListener('focusout', onFocusOut);
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      close();
      trigger.removeEventListener('click', onTriggerClick);
      trigger.removeEventListener('keydown', onTriggerKey);
      popup.removeEventListener('keydown', onPopupKey);
      search.removeEventListener('input', onSearchInput);
      wrap.removeEventListener('focusout', onFocusOut);
      wrap.remove();
    },
  };
};
