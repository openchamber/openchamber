import { mountButton, type ButtonSize, type ButtonVariant } from './button.ts';
import { clearNode, el, ensureStyle, type Handle } from './dom.ts';
import { moveListSelection, navigationKey } from './navigation.ts';
import { createOption, highlightOption } from './option.ts';
import { openPopup } from './popup.ts';
import { UI_CSS } from './style.ts';

export type MenuItem =
  | { id: string; label: string; destructive?: boolean; disabled?: boolean }
  | { separator: true };

export type MenuProps = {
  /** Trigger button label. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  items: MenuItem[];
  onSelect: (id: string) => void;
};

export type MenuHandle = Handle<MenuProps>;

type Action = Exclude<MenuItem, { separator: true }>;

const actions = (items: readonly MenuItem[]): Action[] => (
  items.filter((item): item is Action => !('separator' in item))
);

let menuCount = 0;

export const mountMenu = (root: Element, initial: MenuProps): MenuHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const uid = `oc-sdk-menu-${menuCount += 1}`;
  const wrap = el('div', 'oc-sdk oc-sdk-menu');
  root.append(wrap);
  const popup = el('div', 'oc-sdk oc-sdk-popup');
  popup.setAttribute('role', 'menu');
  popup.tabIndex = -1;
  let closePopup: (() => void) | null = null;
  let activeId: string | null = null;

  const trigger = mountButton(wrap, {
    label: props.label,
    variant: props.variant,
    size: props.size,
    onClick: () => {
      if (closePopup) close(); else open();
    },
  });
  const triggerNode = wrap.querySelector('button');
  triggerNode?.setAttribute('aria-haspopup', 'menu');

  const setActive = (id: string | null): void => {
    activeId = id;
    highlightOption(popup, popup, uid, id);
  };

  const paintItems = (): void => {
    clearNode(popup);
    for (const item of props.items) {
      if ('separator' in item) {
        const line = el('div', 'oc-sdk-separator');
        line.dataset.labeled = 'false';
        popup.append(line);
        continue;
      }
      popup.append(createOption(uid, 'menuitem', item, {
        hover: () => setActive(item.id),
        pick: () => pick(item.id),
      }));
    }
    setActive(actions(props.items).some((item) => item.id === activeId) ? activeId : null);
  };

  const close = (): void => {
    closePopup?.();
    closePopup = null;
    activeId = null;
    triggerNode?.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    if (closePopup || !triggerNode) {
      return;
    }
    paintItems();
    closePopup = openPopup(wrap, triggerNode, popup, close);
    triggerNode.setAttribute('aria-expanded', 'true');
    popup.focus();
  };
  const pick = (id: string): void => {
    close();
    triggerNode?.focus();
    props.onSelect(id);
  };

  const onPopupKey = (event: KeyboardEvent): void => {
    const step = navigationKey(event);
    if (step) {
      event.preventDefault();
      setActive(moveListSelection(actions(props.items), activeId, step));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (activeId) pick(activeId);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      triggerNode?.focus();
    }
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (closePopup && !(event.relatedTarget instanceof Node && wrap.contains(event.relatedTarget))) close();
  };
  popup.addEventListener('keydown', onPopupKey);
  wrap.addEventListener('focusout', onFocusOut);

  return {
    update: (next) => {
      props = { ...props, ...next };
      trigger.update({ label: props.label, variant: props.variant, size: props.size });
      if (closePopup) paintItems();
    },
    dispose: () => {
      close();
      popup.removeEventListener('keydown', onPopupKey);
      wrap.removeEventListener('focusout', onFocusOut);
      trigger.dispose();
      wrap.remove();
    },
  };
};
