import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { SIDEBAR_SECTION_NAME_MAX } from '@/lib/sidebarSections';
import { closePinListRequest, createPinListWithSection, useSidebarSectionsUiStore } from './sectionActions';

/** Names a new pin list for Pin to; the list gets its own section and the work is pinned into it. */
export const NewPinListDialog: React.FC = () => {
  const { t } = useI18n();
  const request = useSidebarSectionsUiStore((state) => state.pinListRequest);
  const [name, setName] = React.useState('');
  const inputId = React.useId();
  React.useEffect(() => {
    if (request) setName('');
  }, [request]);
  const trimmed = name.trim();
  const submit = (): void => {
    if (!request || !trimmed) return;
    const list = createPinListWithSection(trimmed);
    closePinListRequest();
    if (list) request.pin(list.id);
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) closePinListRequest(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.pinTo.newListTitle')}</DialogTitle>
          <DialogDescription>{t('sessions.sidebar.pinTo.newListDescription')}</DialogDescription>
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
          <Button variant="outline" onClick={closePinListRequest}>{t('sessions.sidebar.sections.cancel')}</Button>
          <Button onClick={submit} disabled={!trimmed}>{t('sessions.sidebar.pinTo.newListCreate')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
