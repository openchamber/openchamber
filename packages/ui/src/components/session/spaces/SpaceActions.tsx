/**
 * The actions of an isolated space: apply its work (user journey step 6) above the repair actions
 * (step 8), from soft to hard: restart OpenCode, restart the container, stop or start, and delete
 * after a confirmation, which offers to apply first. The
 * desktop has them in a menu on the space's group; the phone opens the same list as a sheet from
 * the group's swipe actions. Delete never runs from the list itself: it opens the confirmation,
 * which says what goes with the space. The space's chats go to the Archive page first (decision 9);
 * when they cannot all be saved the space stays and the confirmation opens again with "Delete
 * anyway", and once they went, a notice says where they are, with "Open".
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
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { isSpaceActionUnavailable, isSpaceApplicable, runSpaceAction, spaceMenuActionsOf } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SPACE_ACTION_TEXT } from './spaceActionText';

const ACTION_ICON = {
  start: 'play',
  stop: 'stop',
  restart_opencode: 'refresh',
  restart: 'restart',
  setup: 'terminal-box',
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
  return {
    actions: spaceMenuActionsOf(entry),
    applicable: isSpaceApplicable(entry),
    busy,
    unavailable: (action: SpaceAction) => isSpaceActionUnavailable(entry, action),
  };
};

const openApply = (spaceId: string) => useSpacesStore.getState().openApplyDialog(spaceId);

/** The "⋯" menu on a space's group header, beside the grant key and the new-session button. */
export const SpaceActionsMenu: React.FC<{ spaceId: string; label: string; className?: string }> = ({ spaceId, label, className }) => {
  const { t } = useI18n();
  const { actions, applicable, busy, unavailable } = useSpaceActions(spaceId);
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
        {applicable ? (
          <>
            <DropdownMenuItem disabled={busy} onClick={() => openApply(spaceId)} className="gap-2">
              <Icon name="git-merge" className="h-4 w-4" />
              {t('spaces.actions.apply')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {actions.map((action) => (
          <React.Fragment key={action}>
            {action === 'remove' && actions.length > 1 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={action === 'remove' ? 'destructive' : 'default'}
              disabled={busy || unavailable(action)}
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
  const { actions, applicable, busy, unavailable } = useSpaceActions(spaceId ?? '');
  const close = () => useSpacesStore.getState().closeActionsSheet();
  return (
    <MobileOverlayPanel open={spaceId !== null} title={name ?? t('spaces.actions.menu')} onClose={close}>
      <div className="flex flex-col gap-1 px-3 pb-4 pt-1">
        {spaceId && applicable ? (
          <Button
            variant="ghost"
            className="justify-start gap-2"
            disabled={busy}
            onClick={() => {
              close();
              openApply(spaceId);
            }}
          >
            <Icon name="git-merge" className="h-4 w-4" />
            {t('spaces.actions.apply')}
          </Button>
        ) : null}
        {spaceId ? actions.map((action) => (
          <Button
            key={action}
            variant={action === 'remove' ? 'destructive' : 'ghost'}
            className="justify-start gap-2"
            disabled={busy || unavailable(action)}
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

/**
 * Says once that a deleted space's chats are on the Archive page, with the way there. The phone's
 * layout has no Archive page, so there the notice has no "Open" that would lead nowhere.
 */
const useArchivedNotice = () => {
  const { t } = useI18n();
  const name = useSpacesStore((state) => state.archivedNotice);
  const isMobile = useUIStore((state) => state.isMobile);
  React.useEffect(() => {
    if (name === null) return;
    useSpacesStore.getState().noteChatsArchived(null);
    const text = t('spaces.archive.notice', { name });
    if (isMobile) {
      toast.success(text);
      return;
    }
    toast.success(text, {
      // A space deleted from Settings: the Archive page would open behind its window.
      action: {
        label: t('spaces.archive.noticeOpen'),
        onClick: () => {
          useUIStore.getState().setSettingsDialogOpen(false);
          useUIStore.getState().setArchivePageOpen(true);
        },
      },
    });
  }, [isMobile, name, t]);
};

/** The confirmation before a space is deleted; the deletion's progress and failure show on the group. */
export const SpaceDeleteDialog: React.FC = () => {
  const { t } = useI18n();
  useArchivedNotice();
  const isMobile = useUIStore((state) => state.isMobile);
  const spaceId = useSpacesStore((state) => state.deleteDialog);
  const unsaved = useSpacesStore((state) => state.deleteUnsaved);
  const name = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.name ?? '' : ''));
  const applicable = useSpacesStore((state) => isSpaceApplicable(spaceId ? state.journey?.get(spaceId) : undefined));
  const close = () => useSpacesStore.getState().closeDeleteDialog();
  const confirm = () => {
    if (!spaceId) return;
    close();
    void runSpaceAction(spaceId, 'remove', { deleteUnsavedChats: unsaved !== null });
  };
  const applyFirst = () => {
    if (!spaceId) return;
    close();
    openApply(spaceId);
  };
  const title = t('spaces.delete.title', { name });
  const buttons = (
    <div className="flex w-full justify-end gap-2">
      {applicable ? <Button variant="outline" size="sm" className="mr-auto" onClick={applyFirst}>{t('spaces.delete.applyFirst')}</Button> : null}
      <Button variant="outline" size="sm" onClick={close}>{t('spaces.delete.cancel')}</Button>
      <Button variant="destructive" size="sm" onClick={confirm}>{unsaved ? t('spaces.delete.deleteAnyway') : t('spaces.delete.confirm')}</Button>
    </div>
  );
  // After chats could not be saved: a line for the whole when anything but size failed, and one
  // per chat too large to save, named by its title from the space, shown as text.
  const lines = unsaved
    ? [
      ...(unsaved.failed > 0 || unsaved.tooLarge.length === 0 ? [t('spaces.delete.chatsNotSaved', { name })] : []),
      ...unsaved.tooLarge.map((chatTitle) => t('spaces.delete.chatTooLarge', { title: chatTitle })),
    ]
    : [t('spaces.delete.body')];

  if (isMobile) {
    return (
      <MobileOverlayPanel open={spaceId !== null} title={title} onClose={close} footer={buttons}>
        <div className="flex flex-col gap-1 px-3 pb-4 pt-1">
          {lines.map((line, index) => <p key={index} className="typography-meta text-muted-foreground">{line}</p>)}
        </div>
      </MobileOverlayPanel>
    );
  }
  return (
    <Dialog open={spaceId !== null} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="flex flex-col gap-1">
            {lines.map((line, index) => <span key={index}>{line}</span>)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>{buttons}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
