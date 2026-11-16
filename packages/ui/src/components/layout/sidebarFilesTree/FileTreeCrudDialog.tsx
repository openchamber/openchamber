import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import type { FileTreeDialogData, FileTreeDialogType } from './useFileTreeDialogs';

export const FileTreeCrudDialog: React.FC<{
  activeDialog: FileTreeDialogType | null;
  dialogData: FileTreeDialogData | null;
  inputValue: string;
  isSubmitting: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}> = ({ activeDialog, dialogData, inputValue: dialogInputValue, isSubmitting: isDialogSubmitting, onInputChange, onSubmit, onClose }) => {
  const { t } = useI18n();
  return (
    <Dialog open={!!activeDialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {activeDialog === 'createFile' && t('sidebarFilesTree.dialog.createFile.title')}
            {activeDialog === 'createFolder' && t('sidebarFilesTree.dialog.createFolder.title')}
            {activeDialog === 'rename' && t('sidebarFilesTree.dialog.rename.title')}
            {activeDialog === 'delete' && t('sidebarFilesTree.dialog.delete.title')}
          </DialogTitle>
          <DialogDescription>
            {activeDialog === 'createFile' && t('sidebarFilesTree.dialog.createFile.description', { path: dialogData?.path ?? t('sidebarFilesTree.dialog.rootFallback') })}
            {activeDialog === 'createFolder' && t('sidebarFilesTree.dialog.createFolder.description', { path: dialogData?.path ?? t('sidebarFilesTree.dialog.rootFallback') })}
            {activeDialog === 'rename' && t('sidebarFilesTree.dialog.rename.description', { name: dialogData?.name ?? '' })}
            {activeDialog === 'delete' && t('sidebarFilesTree.dialog.delete.description', { name: dialogData?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {activeDialog !== 'delete' && (
          <div className="py-4">
            <Input
              value={dialogInputValue}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={activeDialog === 'rename' ? t('sidebarFilesTree.dialog.rename.placeholder') : t('sidebarFilesTree.dialog.namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onSubmit();
                }
              }}
              autoFocus
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()} disabled={isDialogSubmitting}>
            {t('sidebarFilesTree.dialog.cancel')}
          </Button>
          <Button
            variant={activeDialog === 'delete' ? 'destructive' : 'default'}
            onClick={() => onSubmit()}
            disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
          >
            {isDialogSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : (
              activeDialog === 'delete' ? t('sidebarFilesTree.dialog.delete.confirm') : t('sidebarFilesTree.dialog.confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
