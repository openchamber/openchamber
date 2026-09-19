import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { normalizeTerminalDirectory } from '@/lib/pathNormalization';
import { isActiveProjectActionTab, useTerminalStore } from '@/stores/useTerminalStore';
import { cn } from '@/lib/utils';

/** A directory-scoped leaf subscription; output chunks do not rerender the indicator. */
export const DirectoryActionIndicator = ({ directory, className }: { directory: string; className?: string }) => {
  const { t } = useI18n();
  const key = normalizeTerminalDirectory(directory);
  const state = useTerminalStore(React.useCallback(store => store.sessions.get(key), [key]));
  const active = state?.tabs.some(isActiveProjectActionTab);
  if (!active) return null;
  const label = t('sessions.sidebar.projectAction.active');
  return <span className={cn('inline-flex shrink-0 items-center text-status-info', className)} role="img" aria-label={label} title={label} data-action-directory={key}>
    <Icon name="pulse" className="size-3.5" />
  </span>;
};
