import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RiCheckboxBlankLine, RiCheckboxLine } from '@remixicon/react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useTranslation } from 'react-i18next';

export type DeleteSessionConfirmState = {
  session: Session;
  descendantCount: number;
  archivedBucket: boolean;
} | null;

export function SessionDeleteConfirmDialog(props: {
  value: DeleteSessionConfirmState;
  setValue: (next: DeleteSessionConfirmState) => void;
  showDeletionDialog: boolean;
  setShowDeletionDialog: (next: boolean) => void;
  onConfirm: () => Promise<void> | void;
}): React.ReactNode {
  const { t } = useTranslation();
  const { value, setValue, showDeletionDialog, setShowDeletionDialog, onConfirm } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{value?.archivedBucket ? t('sessionsSidebar.deleteSessionQuestion') : t('sessionsSidebar.archiveSessionQuestion')}</DialogTitle>
          <DialogDescription>
            {value && value.descendantCount > 0
              ? value.archivedBucket
                ? t('sessionsSidebar.willDeleteWithSubtasks', { title: value.session.title || t('sessionsSidebar.untitledSession'), count: value.descendantCount })
                : t('sessionsSidebar.willArchiveWithSubtasks', { title: value.session.title || t('sessionsSidebar.untitledSession'), count: value.descendantCount })
              : value?.archivedBucket
                ? t('sessionsSidebar.willDeleteSession', { title: value?.session.title || t('sessionsSidebar.untitledSession') })
                : t('sessionsSidebar.willArchiveSession', { title: value?.session.title || t('sessionsSidebar.untitledSession') })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="w-full sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setShowDeletionDialog(!showDeletionDialog)}
            className="inline-flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            aria-pressed={!showDeletionDialog}
          >
            {!showDeletionDialog ? <RiCheckboxLine className="h-4 w-4 text-primary" /> : <RiCheckboxBlankLine className="h-4 w-4" />}
            {t('sessions.neverAsk')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setValue(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {t('sessions.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              {value?.archivedBucket ? t('sessionsSidebar.delete') : t('sessionsSidebar.archive')}
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
  const { t } = useTranslation();
  const { value, setValue, onConfirm } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessionsSidebar.deleteFolderQuestion')}</DialogTitle>
          <DialogDescription>
            {value && (value.subFolderCount > 0 || value.sessionCount > 0)
              ? t('sessionsSidebar.deleteFolderWithSubfolders', { name: value.folderName, suffix: value.subFolderCount > 0 ? ` along with ${value.subFolderCount} sub-folder${value.subFolderCount === 1 ? '' : 's'}` : '' })
              : t('sessionsSidebar.deleteFolderPermanent', { name: value?.folderName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setValue(null)}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {t('sessions.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            {t('sessionsSidebar.delete')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
