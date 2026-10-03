import { applyTone, type Tone } from './badge.ts';
import { button, clearNode, el, ensureStyle, setAttr, type Handle } from './dom.ts';
import { moveListSelection, navigationKey } from './navigation.ts';
import { UI_CSS } from './style.ts';

export type ListItem = {
  id: string;
  title: string;
  /** Micro muted line under the title. */
  subtitle?: string;
  /** Fixed-width mono text before the title, like an issue key. */
  leading?: string;
  /** Muted tabular text at the right, like a date or count. */
  meta?: string;
  badge?: { label: string; tone?: Tone };
  disabled?: boolean;
};

export type ListProps = {
  items: ListItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  emptyText?: string;
  ariaLabel?: string;
};

export type ListHandle = Handle<ListProps>;

let listCount = 0;

export const mountList = (root: Element, initial: ListProps): ListHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const uid = `oc-sdk-list-${listCount += 1}`;
  const list = el('div', 'oc-sdk oc-sdk-list');
  list.setAttribute('role', 'listbox');
  list.tabIndex = 0;
  root.append(list);
  let activeId: string | null = null;

  const rowId = (id: string): string => `${uid}-${id}`;

  const setActive = (id: string | null): void => {
    activeId = id;
    for (const row of Array.from(list.children)) {
      if (row instanceof HTMLElement) {
        row.dataset.active = row.id === rowId(id ?? '') ? 'true' : 'false';
      }
    }
    setAttr(list, 'aria-activedescendant', id ? rowId(id) : null);
    list.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  const span = (className: string, text: string): HTMLSpanElement => {
    const node = el('span', className);
    node.textContent = text;
    return node;
  };

  const paint = (): void => {
    clearNode(list);
    setAttr(list, 'aria-label', props.ariaLabel);
    if (props.items.length === 0) {
      list.append(span('oc-sdk-list-empty', props.emptyText ?? 'Nothing here'));
      setActive(null);
      return;
    }
    for (const item of props.items) {
      const row = button('oc-sdk-row');
      row.id = rowId(item.id);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', item.id === props.selectedId ? 'true' : 'false');
      row.disabled = Boolean(item.disabled);
      row.tabIndex = -1;
      if (item.leading) row.append(span('oc-sdk-row-lead', item.leading));
      const main = el('span', 'oc-sdk-row-main');
      main.append(span('oc-sdk-row-title', item.title));
      if (item.subtitle) main.append(span('oc-sdk-row-sub', item.subtitle));
      row.append(main);
      if (item.badge) {
        const badge = span('oc-sdk-badge', item.badge.label);
        applyTone(badge, item.badge.tone);
        row.append(badge);
      }
      if (item.meta) row.append(span('oc-sdk-row-meta', item.meta));
      row.addEventListener('click', () => props.onSelect(item.id));
      list.append(row);
    }
    const stillThere = props.items.some((item) => item.id === activeId && !item.disabled);
    setActive(stillThere ? activeId : props.selectedId ?? null);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = navigationKey(event);
    if (step) {
      event.preventDefault();
      setActive(moveListSelection(props.items, activeId, step));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && activeId) {
      event.preventDefault();
      props.onSelect(activeId);
    }
  };
  list.addEventListener('keydown', onKeyDown);
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      list.removeEventListener('keydown', onKeyDown);
      list.remove();
    },
  };
};
