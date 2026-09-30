/**
 * One isolated space as the lists of spaces show it (DESIGN.md, user journey step 9): the project's
 * spaces page, the spaces without a project in Settings, and the phone's project editor. Its name,
 * its network, the status line its group in the sidebar has, and the same two actions as the group:
 * the grant dialog's key and the actions, a menu on the desktop and the sheet on the phone. A space
 * whose project is no longer registered also names the folder it was made for.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { SpaceActionsMenu } from './SpaceActions';
import { SpaceGroupStatus } from './SpaceGroupStatus';

const ACTION_BUTTON_CLASS = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const BADGE_CLASS = 'shrink-0 typography-micro px-1 rounded leading-none pb-px';

/**
 * The space's network as a badge beside its name: allowed addresses only in the success tone,
 * open internet in the warning tone the create dialog uses for it, and a network the host could
 * not read in a neutral one, never as either.
 */
const NetworkBadge: React.FC<{ network: SpaceEntry['network'] }> = ({ network }) => {
  const { t } = useI18n();
  if (network === null) {
    return <span className={cn(BADGE_CLASS, 'text-muted-foreground bg-[var(--surface-subtle)]')}>{t('spaces.row.network.unknown')}</span>;
  }
  if (network.mode === 'open') {
    return <span className={cn(BADGE_CLASS, 'text-[var(--status-warning)] bg-[var(--status-warning)]/10')}>{t('spaces.create.network.open')}</span>;
  }
  return <span className={cn(BADGE_CLASS, 'text-[var(--status-success)] bg-[var(--status-success)]/10')}>{t('spaces.row.network.allowlist')}</span>;
};

/** The folder a space was made for, and that it is gone when it is. */
const FolderLine: React.FC<{ folder: SpaceEntry['projectFolder'] }> = ({ folder }) => {
  const { t } = useI18n();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  if (folder.path === null) return null;
  // The path wraps rather than being cut: its end, the folder's name, is what the user knows it by.
  return (
    <>
      <p className="typography-micro break-all text-muted-foreground">{formatPathForDisplay(folder.path, homeDirectory)}</p>
      {folder.found === false ? <p className="typography-micro text-[var(--status-warning)]">{t('spaces.row.folderNotFound')}</p> : null}
    </>
  );
};

export const SpaceRow: React.FC<{
  entry: SpaceEntry;
  /** The phone opens the actions as a sheet, where the desktop has a menu. */
  actions: 'menu' | 'sheet';
  /** For a space whose project is no longer registered: where it came from. */
  showFolder?: boolean;
}> = ({ entry, actions, showFolder = false }) => {
  const { t } = useI18n();
  return (
    <div className="flex w-full items-start gap-2 py-1.5" data-space-row={entry.id}>
      <Icon name="box-3" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {/* The badge wraps under a long name rather than cutting it: the name is what the user knows the space by. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {/* A name from the label: text to show. */}
          <p className="typography-ui-label min-w-0 max-w-full truncate text-foreground">{entry.name}</p>
          <NetworkBadge network={entry.network} />
        </div>
        {showFolder ? <FolderLine folder={entry.projectFolder} /> : null}
        <SpaceGroupStatus spaceId={entry.id} className="pt-1" />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className={ACTION_BUTTON_CLASS}
          onClick={() => useSpacesStore.getState().openAccessDialog(entry.id)}
          aria-label={t('spaces.group.access.giveAria', { label: entry.name })}
          title={t('spaces.group.access.give')}
        >
          <Icon name="key" className="h-4 w-4" />
        </button>
        {actions === 'menu' ? (
          <SpaceActionsMenu spaceId={entry.id} label={entry.name} className={ACTION_BUTTON_CLASS} />
        ) : (
          <button
            type="button"
            className={ACTION_BUTTON_CLASS}
            onClick={() => useSpacesStore.getState().openActionsSheet(entry.id)}
            aria-label={t('spaces.actions.menuAria', { label: entry.name })}
          >
            <Icon name="more-2" className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
};
