import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface DialogsProps {
  activeDialog: 'createFile' | 'createFolder' | 'rename' | 'delete' | null;
  dialogData: { path: string; name?: string; type?: 'file' | 'directory' } | null;
  dialogInputValue: string;
  onDialogInputChange: (value: string) => void;
  isDialogSubmitting: boolean;
  onDialogSubmit: (e?: React.FormEvent) => Promise<void>;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export const Dialogs: React.FC<DialogsProps> = ({
  activeDialog,
  dialogData,
  dialogInputValue,
  onDialogInputChange,
  isDialogSubmitting,
  onDialogSubmit,
  onClose,
  inputRef,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={!!activeDialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>
            {activeDialog === 'createFile' && t('filesView.dialog.createFile.title')}
            {activeDialog === 'createFolder' && t('filesView.dialog.createFolder.title')}
            {activeDialog === 'rename' && t('filesView.dialog.rename.title')}
            {activeDialog === 'delete' && t('filesView.dialog.delete.title')}
          </DialogTitle>
          <DialogDescription>
            {activeDialog === 'createFile' && t('filesView.dialog.createFile.description', { path: dialogData?.path ?? t('filesView.dialog.rootFallback') })}
            {activeDialog === 'createFolder' && t('filesView.dialog.createFolder.description', { path: dialogData?.path ?? t('filesView.dialog.rootFallback') })}
            {activeDialog === 'rename' && t('filesView.dialog.rename.description', { name: dialogData?.name ?? '' })}
            {activeDialog === 'delete' && t('filesView.dialog.delete.description', { name: dialogData?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {activeDialog !== 'delete' && (
          <div className="py-4">
            <Input
              value={dialogInputValue}
              onChange={(e) => onDialogInputChange(e.target.value)}
              placeholder={activeDialog === 'rename' ? t('filesView.dialog.rename.placeholder') : t('filesView.dialog.namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void onDialogSubmit();
                }
              }}
              ref={inputRef}
              />
            </div>
          )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDialogSubmitting}>
            {t('filesView.dialog.cancel')}
          </Button>
          <Button
            variant={activeDialog === 'delete' ? 'destructive' : 'default'}
            onClick={() => void onDialogSubmit()}
            disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
          >
            {isDialogSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : (
                activeDialog === 'delete' ? t('filesView.dialog.delete.confirm') : t('filesView.dialog.confirm')
            )}
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  };
