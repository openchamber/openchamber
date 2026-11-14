import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionMenuItemHint } from './SessionMenuItemHint';
import { useI18n } from '@/lib/i18n';
import { useSessionAiRenameAction } from './useSessionAiRenameAction';

/** Mounted in the sidebar, tab context menus and the single-session header. */
export function SessionAiRenameMenuItem({ sessionID, directory, open, Item }: {
  sessionID: string;
  directory: string | null | undefined;
  open: boolean;
  Item: React.ElementType;
}) {
  const { t } = useI18n();
  const { pending, disabled, hint, run } = useSessionAiRenameAction(sessionID, directory, open);

  // The span keeps the hint reachable while the item is disabled, which is
  // exactly when the hint says why.
  return (
    <SessionMenuItemHint hint={hint}>
      <span className="block">
        <Item
          disabled={disabled}
          onClick={run}
          className="w-full"
        >
          {/* The slot every item's icon takes (the menu draws them at 14px),
              so the label starts where theirs do. ai-generate-2 ink fills
              ~22/24 of the viewBox vs 20/24 for sibling Remixicons, so it
              draws a pixel smaller inside it. */}
          <span className="me-1 inline-flex size-3.5 shrink-0 items-center justify-center">
            <Icon name={pending ? 'loader-4' : 'ai-generate-2'} className={pending ? 'size-3.5 animate-spin' : 'size-[13px]'} />
          </span>
          {t('sessions.aiRename.action')}
        </Item>
      </span>
    </SessionMenuItemHint>
  );
}
