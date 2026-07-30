import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';

export type DeleteSessionConfirmState = {
  session: Session;
  descendantCount: number;
  // Snapshot of the descendant IDs computed when the dialog opened, so the
  // executed list matches the count shown to the user even if childrenMap
  // changes while the dialog is open.
  descendantIds: string[];
} | null;

export function SessionDeleteConfirmDialog(props: {
  value: DeleteSessionConfirmState;
  setValue: (next: DeleteSessionConfirmState) => void;
  showDeletionDialog: boolean;
  setShowDeletionDialog: (next: boolean) => void;
  onConfirm: () => Promise<void> | void;
}): React.ReactNode {
  const { t } = useI18n();
  const { value, setValue, showDeletionDialog, setShowDeletionDialog, onConfirm } = props;
  const untitledSession = t('sessions.sidebar.session.untitled');

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.dialogs.archiveSession.title')}</DialogTitle>
          <DialogDescription>
            {value && value.descendantCount > 0
              ? value.descendantCount === 1
                ? t('sessions.sidebar.dialogs.archiveSession.withOneSubtask', {
                  sessionTitle: value.session.title || untitledSession,
                  count: value.descendantCount,
                })
                : t('sessions.sidebar.dialogs.archiveSession.withManySubtasks', {
                  sessionTitle: value.session.title || untitledSession,
                  count: value.descendantCount,
                })
              : t('sessions.sidebar.dialogs.archiveSession.single', {
                sessionTitle: value?.session.title || untitledSession,
              })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="w-full sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setShowDeletionDialog(!showDeletionDialog)}
            className="inline-flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            aria-pressed={!showDeletionDialog}
          >
            {!showDeletionDialog ? <Icon name="checkbox" className="h-4 w-4 text-primary" /> : <Icon name="checkbox-blank" className="h-4 w-4" />}
            {t('sessions.sidebar.dialogs.neverAsk')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setValue(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              {t('sessions.sidebar.bulkActions.archive')}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type BulkDeleteSessionsConfirmState = {
  sessionCount: number;
} | null;

export function BulkSessionDeleteConfirmDialog(props: {
  value: BulkDeleteSessionsConfirmState;
  setValue: (next: BulkDeleteSessionsConfirmState) => void;
  showDeletionDialog: boolean;
  setShowDeletionDialog: (next: boolean) => void;
  onConfirm: () => Promise<void> | void;
}): React.ReactNode {
  const { t } = useI18n();
  const { value, setValue, showDeletionDialog, setShowDeletionDialog, onConfirm } = props;
  const n = value?.sessionCount ?? 0;
  const title = n === 1
    ? t('sessions.sidebar.dialogs.archiveSession.title')
    : t('sessions.sidebar.dialogs.archiveSessions.title');
  const description = n === 1
    ? t('sessions.sidebar.dialogs.archiveSessions.singleDescription', { count: n })
    : t('sessions.sidebar.dialogs.archiveSessions.pluralDescription', { count: n });

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="w-full sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setShowDeletionDialog(!showDeletionDialog)}
            className="inline-flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            aria-pressed={!showDeletionDialog}
          >
            {!showDeletionDialog ? <Icon name="checkbox" className="h-4 w-4 text-primary" /> : <Icon name="checkbox-blank" className="h-4 w-4" />}
            {t('sessions.sidebar.dialogs.neverAsk')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setValue(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              {t('sessions.sidebar.bulkActions.archive')}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type DeleteFolderConfirmState = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

export function FolderDeleteConfirmDialog(props: {
  value: DeleteFolderConfirmState;
  setValue: (next: DeleteFolderConfirmState) => void;
  onConfirm: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const { value, setValue, onConfirm } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.dialogs.deleteFolder.title')}</DialogTitle>
          <DialogDescription>
            {value && (value.subFolderCount > 0 || value.sessionCount > 0)
              ? value.subFolderCount > 0
                ? value.subFolderCount === 1
                  ? t('sessions.sidebar.dialogs.deleteFolder.withOneSubfolder', {
                    folderName: value.folderName,
                    count: value.subFolderCount,
                  })
                  : t('sessions.sidebar.dialogs.deleteFolder.withManySubfolders', {
                    folderName: value.folderName,
                    count: value.subFolderCount,
                  })
                : t('sessions.sidebar.dialogs.deleteFolder.withContentsNoSubfolders', {
                  folderName: value.folderName,
                })
              : t('sessions.sidebar.dialogs.deleteFolder.single', {
                folderName: value?.folderName ?? '',
              })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setValue(null)}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {t('sessions.sidebar.dialogs.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            {t('sessions.sidebar.bulkActions.delete')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
