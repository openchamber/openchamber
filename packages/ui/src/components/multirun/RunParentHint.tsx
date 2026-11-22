import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { getMultiRunIdentity } from '@/lib/multirun/identity';
import type { Session } from '@/lib/opencode/model';
import { useSessionSelector } from '@/sync/sync-context';

const isParent = (session: Session | undefined): boolean => Boolean(session && getMultiRunIdentity(session)?.role === 'parent');

/** Return a real empty slot for ordinary sessions, preserving mobile pill layout. */
export function useRunParentHint(sessionId: string | null, directory?: string): React.ReactNode {
  const parent = useSessionSelector(sessionId, directory, isParent);
  const { t } = useI18n();
  if (!parent) return null;
  return <div className="flex items-center gap-1.5 px-3 py-1 typography-meta text-muted-foreground">
    <Icon name="chat-3" className="size-3.5" />
    <span>{t('multirun.parent.title')}</span>
    <SettingsInfoHint>{t('multirun.parent.hint')}</SettingsInfoHint>
  </div>;
}
