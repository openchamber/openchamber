import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block">
          <Item
            disabled={disabled}
            onClick={run}
            className="w-full"
          >
            <Icon name={pending ? 'loader-4' : 'ai-generate-2'} className={pending ? 'mr-2 size-4 animate-spin' : 'mr-2 size-4'} />
            {t('sessions.aiRename.action')}
          </Item>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{hint}</TooltipContent>
    </Tooltip>
  );
}
