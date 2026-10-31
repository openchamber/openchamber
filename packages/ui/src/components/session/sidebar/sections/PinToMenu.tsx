import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_PIN_LIST, SIDEBAR_PIN_LISTS_MAX } from '@/lib/sidebarSections';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { canAddSidebarSection, requestNewPinList } from './sectionActions';

type PinToMenuSlots = {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
};

/**
 * The row menu's Pin item as a submenu: Pinned, the user's pin lists, a new
 * list, and Unpin while pinned. It takes the Pin item's place, so the menu
 * gains no item. `current` is the list the work is pinned in, or null.
 */
export const PinToMenu: React.FC<{
  slots: PinToMenuSlots;
  current: string | null;
  /** `list` null is Pinned. */
  onPin: (list: string | null) => void;
  onUnpin: () => void;
  triggerClassName?: string;
  itemClassName?: string;
}> = ({ slots: { Item, Separator, Sub, SubTrigger, SubContent }, current, onPin, onUnpin, triggerClassName, itemClassName }) => {
  const { t } = useI18n();
  const pinLists = useSessionDisplayStore((state) => state.pinLists);
  const canCreateList = useSessionDisplayStore((state) => state.pinLists.length < SIDEBAR_PIN_LISTS_MAX && canAddSidebarSection(state.sections));
  const check = <Icon name="check" className="ms-auto h-4 w-4 text-primary" />;
  return (
    <Sub>
      <SubTrigger className={triggerClassName}>
        <Icon name="pushpin" className="h-4 w-4" />
        <span>{t('sessions.sidebar.pinTo.label')}</span>
      </SubTrigger>
      <SubContent className="min-w-[180px]">
        <Item className={itemClassName} onClick={() => { if (current !== DEFAULT_PIN_LIST) onPin(null); }}>
          <span className="min-w-0 truncate">{t('sessions.sidebar.activity.pinnedTitle')}</span>
          {current === DEFAULT_PIN_LIST ? check : null}
        </Item>
        {pinLists.map((list) => (
          <Item key={list.id} className={itemClassName} onClick={() => { if (current !== list.id) onPin(list.id); }}>
            <span className="min-w-0 truncate" dir="auto">{list.name}</span>
            {current === list.id ? check : null}
          </Item>
        ))}
        {canCreateList ? <>
          <Separator />
          <Item className={itemClassName} onClick={() => requestNewPinList((listId) => onPin(listId))}>
            <Icon name="add" className="h-4 w-4" />
            <span>{t('sessions.sidebar.pinTo.newList')}</span>
          </Item>
        </> : null}
        {current ? (
          <Item className={itemClassName} onClick={onUnpin}>
            <Icon name="unpin" className="h-4 w-4" />
            <span>{t('sessions.sidebar.session.menu.unpin')}</span>
          </Item>
        ) : null}
      </SubContent>
    </Sub>
  );
};
