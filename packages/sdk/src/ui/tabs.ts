import { button, clearNode, el, ensureStyle, type Handle } from './dom.ts';
import { moveListSelection, navigationKey } from './navigation.ts';
import { UI_CSS } from './style.ts';

export type TabItem = {
  id: string;
  label: string;
  count?: number;
};

export type TabsProps = {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Paints a faint track behind the pills. */
  trackBackground?: boolean;
};

export type TabsHandle = Handle<TabsProps>;

export const mountTabs = (root: Element, initial: TabsProps): TabsHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const track = el('div', 'oc-sdk oc-sdk-tabs');
  track.setAttribute('role', 'tablist');
  root.append(track);

  const paint = (): void => {
    clearNode(track);
    track.dataset.track = props.trackBackground ? 'true' : 'false';
    for (const item of props.items) {
      const tab = button('oc-sdk-tab');
      tab.setAttribute('role', 'tab');
      const active = item.id === props.activeId;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      tab.dataset.id = item.id;
      const label = el('span');
      label.textContent = item.label;
      tab.append(label);
      if (item.count !== undefined) {
        const count = el('span', 'oc-sdk-tab-count');
        count.textContent = String(item.count);
        tab.append(count);
      }
      tab.addEventListener('click', () => {
        if (item.id !== props.activeId) props.onChange(item.id);
      });
      track.append(tab);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = navigationKey(event, 'horizontal');
    if (!step) {
      return;
    }
    const next = moveListSelection(props.items, props.activeId, step);
    if (next && next !== props.activeId) {
      event.preventDefault();
      props.onChange(next);
      const tab = track.querySelector(`[data-id="${CSS.escape(next)}"]`);
      if (tab instanceof HTMLElement) tab.focus();
    }
  };
  track.addEventListener('keydown', onKeyDown);
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      track.removeEventListener('keydown', onKeyDown);
      track.remove();
    },
  };
};
