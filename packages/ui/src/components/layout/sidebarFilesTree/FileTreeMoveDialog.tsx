import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import type { FileTreeEntry } from '../fileTreeMoveDrag';
import { getDropTargetLabel } from './treePaths';

export const FileTreeMoveDialog: React.FC<{
  root: string;
  pendingMove: { source: FileTreeEntry; targetDirectory: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ root, pendingMove, onCancel, onConfirm: handleConfirmMove }) => {
  const { t } = useI18n();
  const confirmFileTreeMove = useUIStore((state) => state.confirmFileTreeMove);
  const setConfirmFileTreeMove = useUIStore((state) => state.setConfirmFileTreeMove);
  const pendingMoveName = pendingMove ? pendingMove.source.path.slice(pendingMove.source.path.lastIndexOf('/') + 1) : '';
  return (
    <Dialog open={pendingMove !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t('sidebarFilesTree.dialog.move.title')}</DialogTitle>
          <DialogDescription>
            {pendingMove ? t('sidebarFilesTree.dialog.move.description', {
              name: pendingMoveName,
              folder: getDropTargetLabel(root, pendingMove.targetDirectory),
            }) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="w-full sm:items-center sm:justify-between">
          <div
            className="flex cursor-pointer items-center gap-2 typography-meta text-muted-foreground"
            onClick={() => setConfirmFileTreeMove(!confirmFileTreeMove)}
          >
            <Checkbox
              checked={!confirmFileTreeMove}
              onChange={(checked) => setConfirmFileTreeMove(!checked)}
              ariaLabel={t('sidebarFilesTree.dialog.move.neverAsk')}
            />
            <span>{t('sidebarFilesTree.dialog.move.neverAsk')}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onCancel()}>
              {t('sidebarFilesTree.dialog.cancel')}
            </Button>
            <Button onClick={handleConfirmMove}>
              {t('sidebarFilesTree.dialog.move.confirm')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
