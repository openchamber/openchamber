/**
 * The actions of an isolated space: apply its work (user journey step 6) and its access dialog
 * (step 4) above the repair actions (step 8), from soft to hard: restart OpenCode, restart the
 * container, stop or start, and delete after a confirmation, which offers to apply first. The
 * desktop has them in the menu and the right-click menu of the space's work row, and in the menu
 * of its row on the spaces page; the phone opens the same list as a sheet from the row's swipe
 * actions. Delete never runs from the list itself: it opens the confirmation,
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
import { isSpaceApplicable, runSpaceAction } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SPACE_ACTION_TEXT } from './spaceActionText';
import { openSpaceApply, pickSpaceAction, useSpaceActions } from './spaceActionsState';
import { SpaceStatusLines } from './SpaceStatus';

const ACTION_ICON = {
  start: 'play',
  stop: 'stop',
  restart_opencode: 'refresh',
  restart: 'restart',
  setup: 'terminal-box',
  remove: 'delete-bin',
} satisfies Record<SpaceAction, IconName>;

const openAccess = (spaceId: string) => useSpacesStore.getState().openAccessDialog(spaceId);

/** The menu parts the items render with: a dropdown's or a right-click menu's. */
type SpaceMenuSlots = {
  Item: React.ComponentType<{ className?: string; disabled?: boolean; onClick?: (event: React.MouseEvent) => void; children?: React.ReactNode }>;
  Separator: React.ComponentType;
};

/** An item a list shows as its own button, so its menu leaves it out. */
type SpaceMenuItem = 'apply' | SpaceAction;

/** The space's actions as menu items: apply and access, then the repairs, delete last. */
export const SpaceMenuItems: React.FC<{ spaceId: string; slots: SpaceMenuSlots; omit?: readonly SpaceMenuItem[] }> = ({ spaceId, slots: { Item, Separator }, omit = [] }) => {
  const { t } = useI18n();
  const { actions: all, applicable, busy, unavailable } = useSpaceActions(spaceId);
  const actions = all.filter((action) => !omit.includes(action));
  return (
    <>
      {applicable && !omit.includes('apply') ? (
        <Item disabled={busy} onClick={() => openSpaceApply(spaceId)}>
          <Icon name="git-merge" className="h-4 w-4" />
          <span>{t('spaces.actions.apply')}</span>
        </Item>
      ) : null}
      <Item onClick={() => openAccess(spaceId)}>
        <Icon name="key" className="h-4 w-4" />
        <span>{t('spaces.actions.access')}</span>
      </Item>
      {actions.map((action) => (
        <React.Fragment key={action}>
          {action === 'remove' || action === actions[0] ? <Separator /> : null}
          <Item
            className={action === 'remove' ? 'text-destructive' : undefined}
            disabled={busy || unavailable(action)}
            onClick={() => pickSpaceAction(spaceId, action)}
          >
            <Icon name={ACTION_ICON[action]} className="h-4 w-4" />
            <span>{t(SPACE_ACTION_TEXT[action])}</span>
          </Item>
        </React.Fragment>
      ))}
    </>
  );
};

const DROPDOWN_SLOTS: SpaceMenuSlots = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };

/** The "⋯" menu of a space's row in the lists of spaces, without what the row shows as buttons. */
export const SpaceActionsMenu: React.FC<{ spaceId: string; label: string; className: string; omit?: readonly SpaceMenuItem[] }> = ({ spaceId, label, className, omit }) => {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={className}
          aria-label={t('spaces.actions.menuAria', { label })}
          title={t('spaces.actions.menu')}
        >
          <Icon name="more-2" className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]" onClick={(event) => event.stopPropagation()}>
        <SpaceMenuItems spaceId={spaceId} slots={DROPDOWN_SLOTS} omit={omit} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The same actions on the phone, as a sheet opened from the row's swipe actions. */
export const SpaceActionsSheet: React.FC = () => {
  const { t } = useI18n();
  const spaceId = useSpacesStore((state) => state.actionsSheet);
  const name = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.name : undefined));
  const { actions, applicable, busy, unavailable } = useSpaceActions(spaceId ?? '');
  const close = () => useSpacesStore.getState().closeActionsSheet();
  return (
    <MobileOverlayPanel open={spaceId !== null} title={name ?? t('spaces.actions.menu')} onClose={close}>
      <div className="flex flex-col gap-1 px-3 pb-4 pt-1">
        {/* What the row's mark stands for: the phone has no tooltip to say it. */}
        {spaceId ? <SpaceStatusLines spaceId={spaceId} className="px-3 pb-2" onAction={close} /> : null}
        {spaceId && applicable ? (
          <Button
            variant="ghost"
            className="justify-start gap-2"
            disabled={busy}
            onClick={() => {
              close();
              openSpaceApply(spaceId);
            }}
          >
            <Icon name="git-merge" className="h-4 w-4" />
            {t('spaces.actions.apply')}
          </Button>
        ) : null}
        {spaceId ? (
          <Button
            variant="ghost"
            className="justify-start gap-2"
            onClick={() => {
              close();
              openAccess(spaceId);
            }}
          >
            <Icon name="key" className="h-4 w-4" />
            {t('spaces.actions.access')}
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
              pickSpaceAction(spaceId, action);
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
  // Closing clears the store at once while the desktop dialog still fades out; it keeps showing what it
  // showed, so the title never reads Delete "" and the buttons do not change under the pointer.
  const [lastShown, setLastShown] = React.useState({ name, unsaved, applicable });
  if (spaceId !== null && (lastShown.name !== name || lastShown.unsaved !== unsaved || lastShown.applicable !== applicable)) {
    setLastShown({ name, unsaved, applicable });
  }
  const shown = spaceId !== null ? { name, unsaved, applicable } : lastShown;
  const close = () => useSpacesStore.getState().closeDeleteDialog();
  const confirm = () => {
    if (!spaceId) return;
    close();
    void runSpaceAction(spaceId, 'remove', { deleteUnsavedChats: unsaved !== null });
  };
  const applyFirst = () => {
    if (!spaceId) return;
    close();
    openSpaceApply(spaceId);
  };
  const title = t('spaces.delete.title', { name: shown.name });
  const buttons = (
    <div className="flex w-full justify-end gap-2">
      {shown.applicable ? <Button variant="outline" size="sm" className="me-auto" onClick={applyFirst}>{t('spaces.delete.applyFirst')}</Button> : null}
      <Button variant="outline" size="sm" onClick={close}>{t('spaces.delete.cancel')}</Button>
      <Button variant="destructive" size="sm" onClick={confirm}>{shown.unsaved ? t('spaces.delete.deleteAnyway') : t('spaces.delete.confirm')}</Button>
    </div>
  );
  // After chats could not be saved: a line for the whole when anything but size failed, and one
  // per chat too large to save, named by its title from the space, shown as text.
  const lines = shown.unsaved
    ? [
      ...(shown.unsaved.failed > 0 || shown.unsaved.tooLarge.length === 0 ? [t('spaces.delete.chatsNotSaved', { name: shown.name })] : []),
      ...shown.unsaved.tooLarge.map((chatTitle) => t('spaces.delete.chatTooLarge', { title: chatTitle })),
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
