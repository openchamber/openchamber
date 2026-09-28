/**
 * The repair actions of an isolated space (DESIGN.md, user journey step 8), from soft to hard:
 * restart OpenCode, restart the container, stop or start, and delete after a confirmation. The
 * desktop has them in a menu on the space's group; the phone opens the same list as a sheet from
 * the group's swipe actions. Delete never runs from the list itself: it opens the confirmation,
 * which says what goes with the space.
 *
 * The sheet and the confirmation are mounted once by the main layout and the mobile app, behind
 * the switch; never in VS Code (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { runSpaceAction, spaceMenuActionsOf } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SPACE_ACTION_TEXT } from './spaceActionText';

const ACTION_ICON = {
  start: 'play',
  stop: 'stop',
  restart_opencode: 'refresh',
  restart: 'restart',
  remove: 'delete-bin',
} satisfies Record<SpaceAction, IconName>;

/** Runs an action picked from the menu or the sheet; delete opens its confirmation instead. */
const pick = (spaceId: string, action: SpaceAction) => {
  if (action === 'remove') useSpacesStore.getState().openDeleteDialog(spaceId);
  else void runSpaceAction(spaceId, action);
};

const useSpaceActions = (spaceId: string) => {
  const entry = useSpacesStore((state) => state.journey?.get(spaceId));
  const busy = useSpacesStore((state) => state.actions.get(spaceId)?.kind === 'running');
  return { actions: spaceMenuActionsOf(entry), busy };
};

/** The "⋯" menu on a space's group header, beside the grant key and the new-session button. */
export const SpaceActionsMenu: React.FC<{ spaceId: string; label: string; className?: string }> = ({ spaceId, label, className }) => {
  const { t } = useI18n();
  const { actions, busy } = useSpaceActions(spaceId);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={className ?? 'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'}
          aria-label={t('spaces.actions.menuAria', { label })}
          title={t('spaces.actions.menu')}
        >
          <Icon name="more-2" className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]" onClick={(event) => event.stopPropagation()}>
        {actions.map((action) => (
          <React.Fragment key={action}>
            {action === 'remove' && actions.length > 1 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={action === 'remove' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() => pick(spaceId, action)}
              className="gap-2"
            >
              <Icon name={ACTION_ICON[action]} className="h-4 w-4" />
              {t(SPACE_ACTION_TEXT[action])}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The same actions on the phone, as a sheet opened from the group's swipe actions. */
export const SpaceActionsSheet: React.FC = () => {
  const { t } = useI18n();
  const spaceId = useSpacesStore((state) => state.actionsSheet);
  const name = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.name : undefined));
  const { actions, busy } = useSpaceActions(spaceId ?? '');
  const close = () => useSpacesStore.getState().closeActionsSheet();
  return (
    <MobileOverlayPanel open={spaceId !== null} title={name ?? t('spaces.actions.menu')} onClose={close}>
      <div className="flex flex-col gap-1 px-3 pb-4 pt-1">
        {spaceId ? actions.map((action) => (
          <Button
            key={action}
            variant={action === 'remove' ? 'destructive' : 'ghost'}
            className="justify-start gap-2"
            disabled={busy}
            onClick={() => {
              close();
              pick(spaceId, action);
            }}
          >
            <Icon name={ACTION_ICON[action]} className="h-4 w-4" />
            {t(SPACE_ACTION_TEXT[action])}
          </Button>
        )) : null}
      </div>
    </MobileOverlayPanel>
  );
};

/** The confirmation before a space is deleted; the deletion's progress and failure show on the group. */
export const SpaceDeleteDialog: React.FC = () => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const spaceId = useSpacesStore((state) => state.deleteDialog);
  const name = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.name ?? '' : ''));
  const close = () => useSpacesStore.getState().closeDeleteDialog();
  const confirm = () => {
    if (!spaceId) return;
    close();
    void runSpaceAction(spaceId, 'remove');
  };
  const title = t('spaces.delete.title', { name });
  const buttons = (
    <div className="flex w-full justify-end gap-2">
      <Button variant="outline" size="sm" onClick={close}>{t('spaces.delete.cancel')}</Button>
      <Button variant="destructive" size="sm" onClick={confirm}>{t('spaces.delete.confirm')}</Button>
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel open={spaceId !== null} title={title} onClose={close} footer={buttons}>
        <p className="px-3 pb-4 pt-1 typography-meta text-muted-foreground">{t('spaces.delete.body')}</p>
      </MobileOverlayPanel>
    );
  }
  return (
    <Dialog open={spaceId !== null} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('spaces.delete.body')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>{buttons}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
