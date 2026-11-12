import React from 'react';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { canAddSidebarSection, closePinToRequest, requestNewPinList, useSidebarSectionsUiStore } from '@/components/session/sidebar/sections/sectionActions';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_PIN_LIST, SIDEBAR_PIN_LISTS_MAX } from '@/lib/sidebarSections';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

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
  return (
    <MobileOverlayPanel open={request !== null} title={t('sessions.sidebar.pinTo.label')} onClose={closePinToRequest}>
      {request ? (
        <>
          <MobileSheetRow icon="pushpin" selected={request.current === DEFAULT_PIN_LIST} onClick={() => choose(() => { if (request.current !== DEFAULT_PIN_LIST) request.pin(null); })}>
            {t('sessions.sidebar.activity.pinnedTitle')}
          </MobileSheetRow>
          {pinLists.map((list) => (
            <MobileSheetRow key={list.id} icon="pushpin" selected={request.current === list.id} onClick={() => choose(() => { if (request.current !== list.id) request.pin(list.id); })}>
              <span dir="auto">{list.name}</span>
            </MobileSheetRow>
          ))}
          {canCreateList ? (
            <MobileSheetRow icon="add" onClick={() => choose(() => requestNewPinList((listId) => request.pin(listId)))}>
              {t('sessions.sidebar.pinTo.newList')}
            </MobileSheetRow>
          ) : null}
          {request.current ? (
            <MobileSheetRow icon="unpin" onClick={() => choose(request.unpin)}>
              {t('sessions.sidebar.session.menu.unpin')}
            </MobileSheetRow>
          ) : null}
        </>
      ) : null}
    </MobileOverlayPanel>
  );
};
