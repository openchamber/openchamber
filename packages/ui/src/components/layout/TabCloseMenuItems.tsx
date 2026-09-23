import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import { MAIN_CHAT_TAB_ID } from '@/lib/workspace/layout';
import { closableTabRanges } from './workspace/closableTabRanges';

/**
 * The close rows of a tab's menu. `closeIds` decides what the ids mean: zone
 * surfaces in the workspace strip, files in the Files strip.
 */
export const TabCloseMenuItems: React.FC<{
  id: string;
  allIds: string[];
  close: () => void;
  closeIds: (ids: readonly string[]) => void;
}> = ({ id, allIds, close, closeIds }) => {
  const { t } = useI18n();
  // The chat leads its zone and owns none of these: it cannot be closed,
  // and the surfaces around it are what "close others" would remove.
  const { closableIds, toLeft, toRight } = closableTabRanges(allIds, id, MAIN_CHAT_TAB_ID);
  const others = closableIds.filter((tabId) => tabId !== id);
  return (
    <>
      {id === MAIN_CHAT_TAB_ID ? null : (
        <ContextMenuItem onClick={close}>
          <Icon name="close" className="mr-2 size-4" />
          {t('contextPanel.tab.menu.close')}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => closeIds(others)} disabled={others.length === 0}>
        <Icon name="expand-horizontal" className="mr-2 size-4" />
        {t('contextPanel.tab.menu.closeOthers')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => closeIds(toLeft)} disabled={toLeft.length === 0}>
        <Icon name="expand-left" className="mr-2 size-4" />
        {t('contextPanel.tab.menu.closeToLeft')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => closeIds(toRight)} disabled={toRight.length === 0}>
        <Icon name="expand-right" className="mr-2 size-4" />
        {t('contextPanel.tab.menu.closeToRight')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => closeIds(closableIds)} disabled={others.length === 0}>
        <Icon name="close-circle" className="mr-2 size-4" />
        {t('contextPanel.tab.menu.closeAll')}
      </ContextMenuItem>
    </>
  );
};
