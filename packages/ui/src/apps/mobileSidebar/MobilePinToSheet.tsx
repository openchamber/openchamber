import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { canAddSidebarSection, closePinToRequest, requestNewPinList, useSidebarSectionsUiStore } from '@/components/session/sidebar/sections/sectionActions';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_PIN_LIST, SIDEBAR_PIN_LISTS_MAX } from '@/lib/sidebarSections';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

const ROW_CLASS = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start typography-ui-label text-foreground active:bg-interactive-hover';

/** The phone's Pin to: Pinned, the user's pin lists, a new list, and Unpin while pinned. */
export const MobilePinToSheet: React.FC = () => {
  const { t } = useI18n();
  const request = useSidebarSectionsUiStore((state) => state.pinToRequest);
  const pinLists = useSessionDisplayStore((state) => state.pinLists);
  const canCreateList = useSessionDisplayStore((state) => state.pinLists.length < SIDEBAR_PIN_LISTS_MAX && canAddSidebarSection(state.sections));
  const choose = (action: () => void): void => {
    closePinToRequest();
    action();
  };
  const check = <Icon name="check" className="ms-auto size-4 text-primary" />;
  return (
    <MobileOverlayPanel open={request !== null} title={t('sessions.sidebar.pinTo.label')} onClose={closePinToRequest}>
      {request ? (
        <div className="flex flex-col gap-0.5 p-2">
          <button type="button" className={ROW_CLASS} onClick={() => choose(() => request.pin(null))}>
            <Icon name="pushpin" className="size-4 text-muted-foreground" />
            <span className="min-w-0 truncate">{t('sessions.sidebar.activity.pinnedTitle')}</span>
            {request.current === DEFAULT_PIN_LIST ? check : null}
          </button>
          {pinLists.map((list) => (
            <button key={list.id} type="button" className={ROW_CLASS} onClick={() => choose(() => request.pin(list.id))}>
              <Icon name="pushpin" className="size-4 text-muted-foreground" />
              <span className="min-w-0 truncate" dir="auto">{list.name}</span>
              {request.current === list.id ? check : null}
            </button>
          ))}
          {canCreateList ? (
            <button type="button" className={ROW_CLASS} onClick={() => choose(() => requestNewPinList((listId) => request.pin(listId)))}>
              <Icon name="add" className="size-4 text-muted-foreground" />
              <span>{t('sessions.sidebar.pinTo.newList')}</span>
            </button>
          ) : null}
          {request.current ? (
            <button type="button" className={ROW_CLASS} onClick={() => choose(request.unpin)}>
              <Icon name="unpin" className="size-4 text-muted-foreground" />
              <span>{t('sessions.sidebar.session.menu.unpin')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </MobileOverlayPanel>
  );
};
