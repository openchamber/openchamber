import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionMenuItemHint } from './SessionMenuItemHint';
import { useI18n } from '@/lib/i18n';
import { useSessionAiRenameAction } from './useSessionAiRenameAction';

export function SessionAiRenameMenuItem({ sessionID, directory, open, Item }: {
  sessionID: string;
  directory: string | null | undefined;
  open: boolean;
  Item: React.ElementType;
}) {
  const { t } = useI18n();
  const { pending, disabled, hint, run } = useSessionAiRenameAction(sessionID, directory, open);

  return (
    <SessionMenuItemHint hint={hint}>
      <span className="block">
        <Item
          disabled={disabled}
          onClick={run}
          className="w-full"
        >
          <span className="me-1 inline-flex size-3.5 shrink-0 items-center justify-center">
            <Icon name={pending ? 'loader-4' : 'ai-generate-2'} className={pending ? 'size-3.5 animate-spin' : 'size-[13px]'} />
          </span>
          {t('sessions.aiRename.action')}
        </Item>
      </span>
    </SessionMenuItemHint>
  );
}
