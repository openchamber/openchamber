
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { Button } from '@/components/ui/button';
import type { I18nKey } from '@/lib/i18n';
import { formatDiskSize, useSpaceDiskBytes } from '@/lib/spaces/space-disk';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SpaceActionsMenu, SpaceMenuItems } from './SpaceActions';
import { openSpaceApply, pickSpaceAction, useSpaceActions } from './spaceActionsState';
import { SPACE_ACTION_TEXT } from './spaceActionText';
import { SpaceStatusLines } from './SpaceStatus';

const SPACE_STATE_TEXT = {
  preparing: 'spaces.row.state.preparing',
  running: 'spaces.row.state.running',
  exited: 'spaces.row.state.stopped',
  failed: 'spaces.row.state.failed',
  missing: 'spaces.row.state.missing',
  unreachable: 'spaces.row.state.unreachable',
} satisfies Record<SpaceEntry['state'], I18nKey>;

const ACTION_BUTTON_CLASS = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const CONTEXT_MENU_SLOTS = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

const BADGE_CLASS = 'shrink-0 typography-micro px-1 rounded leading-none pb-px';

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

const FolderLine: React.FC<{ folder: SpaceEntry['projectFolder'] }> = ({ folder }) => {
  const { t } = useI18n();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  if (folder.path === null) return null;
  return (
    <>
      <p className="typography-micro break-all text-muted-foreground">{formatPathForDisplay(folder.path, homeDirectory)}</p>
      {folder.found === false ? <p className="typography-micro text-[var(--status-warning)]">{t('spaces.row.folderNotFound')}</p> : null}
    </>
  );
};

export const SpaceRow: React.FC<{
  entry: SpaceEntry;
  actions: 'menu' | 'sheet';
  showFolder?: boolean;
}> = ({ entry, actions, showFolder = false }) => {
  const { t } = useI18n();
  const bytes = useSpaceDiskBytes(entry.placeId, entry.id);
  const { actions: available, applicable, busy, unavailable } = useSpaceActions(entry.id);
  const toggle = available.find((action) => action === 'start' || action === 'stop') ?? null;
  const meta = [t(SPACE_STATE_TEXT[entry.state]), ...(bytes !== null ? [formatDiskSize(bytes)] : [])].join(' · ');
  const row = (
    <div className="flex w-full items-start gap-2 py-1.5" data-space-row={entry.id}>
      <Icon name="instance" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <p className="typography-ui-label min-w-0 max-w-full truncate text-foreground">{entry.name}</p>
          <span className="typography-meta text-muted-foreground">{meta}</span>
          <NetworkBadge network={entry.network} />
        </div>
        {showFolder ? <FolderLine folder={entry.projectFolder} /> : null}
        <SpaceStatusLines spaceId={entry.id} className="pt-1" hideStopped />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions === 'menu' ? (
          <>
            {applicable ? (
              <Button variant="outline" size="xs" disabled={busy} onClick={() => openSpaceApply(entry.id)}>{t('spaces.actions.apply')}</Button>
            ) : null}
            {toggle ? (
              <Button variant="outline" size="xs" disabled={busy || unavailable(toggle)} onClick={() => pickSpaceAction(entry.id, toggle)}>{t(SPACE_ACTION_TEXT[toggle])}</Button>
            ) : null}
            <SpaceActionsMenu spaceId={entry.id} label={entry.name} className={ACTION_BUTTON_CLASS} omit={['apply', 'start', 'stop']} />
          </>
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
  if (actions !== 'menu') return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="min-w-[200px]">
        <SpaceMenuItems spaceId={entry.id} slots={CONTEXT_MENU_SLOTS} />
      </ContextMenuContent>
    </ContextMenu>
  );
};
