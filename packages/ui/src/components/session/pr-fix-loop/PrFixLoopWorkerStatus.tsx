import React from 'react';
import { SpaceStatusLines } from '@/components/session/spaces/SpaceStatus';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { FixLoopWorker } from '@/lib/prFixLoop';
import { refreshSpacesJourney, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function PrFixLoopWorkerStatus({ worker, showRefresh = true }: { readonly worker: FixLoopWorker; readonly showRefresh?: boolean }) {
  const { t } = useI18n();
  const entry = useSpacesStore((state) => state.journey?.get(worker.spaceId));
  const [failed, setFailed] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const read = React.useCallback(async () => {
    setReading(true);
    try { await refreshSpacesJourney(); setFailed(false); }
    catch (error) { if (!(error instanceof Error)) throw error; setFailed(true); }
    finally { setReading(false); }
  }, []);
  return <section aria-label={t('prFixLoop.worker.title')} className="min-w-0 space-y-2">
    <p dir="auto" className="break-words typography-meta text-muted-foreground">{entry?.name ?? worker.spaceId}</p>
    <p dir="ltr" className="break-all font-mono typography-meta text-muted-foreground">
      {worker.model.providerID}/{worker.model.modelID}{worker.model.variant ? `#${worker.model.variant}` : ''}
    </p>
    <div role="status"><SpaceStatusLines spaceId={worker.spaceId} /></div>
    {failed || !entry ? <p role="status" className="typography-meta text-status-warning">{t('prFixLoop.worker.unknown')}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={!entry || entry.state !== 'running'}
        onClick={() => useSpacesStore.getState().openAccessDialog(worker.spaceId, worker.model.providerID)}>
        {t('spaces.group.access.give')}
      </Button>
      {showRefresh ? <Button variant="ghost" size="sm" disabled={reading} onClick={() => void read()}>{t('spaces.access.blocked.refresh')}</Button> : null}
      {worker.sessionId && worker.spacePath ? <Button variant="ghost" size="sm" onClick={() => {
        if (worker.sessionId && worker.spacePath) useSessionUIStore.getState().setCurrentSession(worker.sessionId, worker.spacePath);
      }}>{t('prFixLoop.worker.open')}</Button> : null}
    </div>
  </section>;
}
