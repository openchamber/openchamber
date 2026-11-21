import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { SIDEBAR_SECTION_NAME_MAX } from '@/lib/sidebarSections';
import { closeNewFolderRequest, useNewFolderRequest } from './newFolderRequest';

export const NewFolderDialog: React.FC = () => {
  const { t } = useI18n();
  const request = useNewFolderRequest((state) => state.request);
  const [name, setName] = React.useState('');
  const inputId = React.useId();
  React.useEffect(() => {
    if (request) setName('');
  }, [request]);
  const trimmed = name.trim();
  const submit = (): void => {
    if (!request || !trimmed) return;
    closeNewFolderRequest();
    request.create(trimmed);
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) closeNewFolderRequest(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.folders.newFolderTitle')}</DialogTitle>
          {request?.projectLabel ? <DialogDescription>{request.projectLabel}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="typography-ui-label font-medium text-foreground">{t('sessions.sidebar.pinTo.newListName')}</label>
          <Input
            id={inputId}
            value={name}
            maxLength={SIDEBAR_SECTION_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('sessions.sidebar.pinTo.newListPlaceholder')}
            autoFocus
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={closeNewFolderRequest}>{t('sessions.sidebar.sections.cancel')}</Button>
          <Button onClick={submit} disabled={!trimmed}>{t('sessions.sidebar.folders.newFolderCreate')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
