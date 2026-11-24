
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
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { isSpaceApplicable, runSpaceAction } from '@/lib/spaces/space-repair';
import { useSpacesStore, type SpaceAction } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SPACE_ACTION_TEXT } from './spaceActionText';
import { openSpaceApply, pickSpaceAction, useSpaceMenuActions } from './spaceActionsState';
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

type SpaceMenuSlots = {
  Item: React.ComponentType<{ className?: string; disabled?: boolean; onClick?: (event: React.MouseEvent) => void; children?: React.ReactNode }>;
  Separator: React.ComponentType;
};

type SpaceMenuItem = 'apply' | SpaceAction;

export const SpaceMenuItems: React.FC<{ spaceId: string; slots: SpaceMenuSlots; omit?: readonly SpaceMenuItem[] }> = ({ spaceId, slots: { Item, Separator }, omit = [] }) => {
  const { t } = useI18n();
  const { actions: all, applicable, busy, unavailable } = useSpaceMenuActions(spaceId);
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

export const SpaceActionsSheet: React.FC = () => {
  const { t } = useI18n();
  const spaceId = useSpacesStore((state) => state.actionsSheet);
  const name = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.name : undefined));
  const { actions, applicable, busy, unavailable } = useSpaceMenuActions(spaceId ?? '');
  const close = () => useSpacesStore.getState().closeActionsSheet();
  return (
    <MobileOverlayPanel open={spaceId !== null} title={name ?? t('spaces.actions.menu')} onClose={close}>
      {spaceId ? <SpaceStatusLines spaceId={spaceId} className="px-2 pb-2" onAction={close} /> : null}
      {spaceId && applicable ? (
        <MobileSheetRow
          icon="git-merge"
          disabled={busy}
          onClick={() => {
            close();
            openSpaceApply(spaceId);
          }}
        >
          {t('spaces.actions.apply')}
        </MobileSheetRow>
      ) : null}
      {spaceId ? (
        <MobileSheetRow
          icon="key"
          onClick={() => {
            close();
            openAccess(spaceId);
          }}
        >
          {t('spaces.actions.access')}
        </MobileSheetRow>
      ) : null}
      {spaceId ? actions.map((action) => (
        <MobileSheetRow
          key={action}
          icon={ACTION_ICON[action]}
          destructive={action === 'remove'}
          disabled={busy || unavailable(action)}
          onClick={() => {
            close();
            pickSpaceAction(spaceId, action);
          }}
        >
          {t(SPACE_ACTION_TEXT[action])}
        </MobileSheetRow>
      )) : null}
    </MobileOverlayPanel>
  );
};

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

export const SpaceDeleteDialog: React.FC = () => {
  const { t } = useI18n();
  useArchivedNotice();
  const isMobile = useUIStore((state) => state.isMobile);
  const spaceId = useSpacesStore((state) => state.deleteDialog);
  const unsaved = useSpacesStore((state) => state.deleteUnsaved);
  const name = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.name ?? '' : ''));
  const applicable = useSpacesStore((state) => isSpaceApplicable(spaceId ? state.journey?.get(spaceId) : undefined));
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
