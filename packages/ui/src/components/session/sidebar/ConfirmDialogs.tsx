import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RiCheckboxBlankLine, RiCheckboxLine } from '@remixicon/react';
import type { Session } from '@opencode-ai/sdk/v2';

// --- Folder Name Dialog (for create/rename folders) ---

export type FolderNameDialogState = {
  mode: 'create' | 'rename';
  folderId?: string;
  folderName?: string;
} | null;

export function FolderNameDialog(props: {
  value: FolderNameDialogState;
  setValue: (next: FolderNameDialogState) => void;
  onConfirm: (name: string) => void;
}): React.ReactNode {
  const { value, setValue, onConfirm } = props;
  const [inputValue, setInputValue] = React.useState('');

  React.useEffect(() => {
    if (value) {
      setInputValue(value.mode === 'rename' && value.folderName ? value.folderName : '');
    }
  }, [value]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onConfirm(inputValue.trim());
      setValue(null);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) setValue(null);
  };

  return (
    <Dialog open={Boolean(value)} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {value?.mode === 'create' ? 'Create folder' : 'Rename folder'}
            </DialogTitle>
            <DialogDescription>
              {value?.mode === 'create'
                ? 'Enter a name for the new folder.'
                : 'Enter a new name for the folder.'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-3">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Folder name"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              autoFocus
            />
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setValue(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 typography-ui-label text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 disabled:pointer-events-none"
            >
              {value?.mode === 'create' ? 'Create' : 'Rename'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const { value, setValue, showDeletionDialog, setShowDeletionDialog, onConfirm } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{value?.archivedBucket ? 'Delete session?' : 'Archive session?'}</DialogTitle>
          <DialogDescription>
            {value && value.descendantCount > 0
              ? value.archivedBucket
                ? `"${value.session.title || 'Untitled Session'}" and its ${value.descendantCount} sub-task${value.descendantCount === 1 ? '' : 's'} will be permanently deleted.`
                : `"${value.session.title || 'Untitled Session'}" and its ${value.descendantCount} sub-task${value.descendantCount === 1 ? '' : 's'} will be archived.`
              : value?.archivedBucket
                ? `"${value?.session.title || 'Untitled Session'}" will be permanently deleted.`
                : `"${value?.session.title || 'Untitled Session'}" will be archived.`}
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
            Never ask
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setValue(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              {value?.archivedBucket ? 'Delete' : 'Archive'}
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
  const { value, setValue, onConfirm } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>Delete folder?</DialogTitle>
          <DialogDescription>
            {value && (value.subFolderCount > 0 || value.sessionCount > 0)
              ? `"${value.folderName}" will be deleted${value.subFolderCount > 0 ? ` along with ${value.subFolderCount} sub-folder${value.subFolderCount === 1 ? '' : 's'}` : ''}. Sessions inside will not be deleted.`
              : `"${value?.folderName}" will be permanently deleted.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setValue(null)}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
