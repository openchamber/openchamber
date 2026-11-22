import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function AttachSessionDialog({ open, onOpenChange, sessions, busy, onAttach }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: readonly Session[];
  busy: boolean;
  onAttach: (session: Session) => Promise<void>;
}): React.ReactNode {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = sessions.find((session) => session.id === selectedId);
  const filtered = sessions.filter((session) => `${session.title} ${session.directory}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (busy) return;
      if (!next) { setQuery(''); setSelectedId(null); }
      onOpenChange(next);
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('multirun.membership.add')}</DialogTitle>
          <DialogDescription>{t('multirun.membership.addDescription')}</DialogDescription>
        </DialogHeader>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('multirun.membership.search')} aria-label={t('multirun.membership.search')} />
        <div className="flex h-56 flex-col gap-1 overflow-y-auto">
          {filtered.map((session) => (
            <Button key={session.id} variant="chip" aria-pressed={session.id === selectedId} onClick={() => setSelectedId(session.id)} className="shrink-0 justify-start">
              <Icon name={session.id === selectedId ? 'checkbox' : 'checkbox-blank'} className="size-4 shrink-0" />
              <span dir="auto" className="oc-ui-start-align truncate" title={session.directory}>{session.title || session.id}</span>
            </Button>
          ))}
          {filtered.length === 0 ? <p className="typography-meta text-muted-foreground">{t('multirun.membership.empty')}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { setQuery(''); setSelectedId(null); onOpenChange(false); }}>{t('multirun.overview.cancel')}</Button>
          <Button disabled={busy || !selected} onClick={() => { if (selected) void onAttach(selected); }}>{t('multirun.membership.add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
