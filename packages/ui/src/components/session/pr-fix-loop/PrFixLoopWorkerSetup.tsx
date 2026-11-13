import React from 'react';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { isFixLoopWorkerReady, type FixLoopWorker } from '@/lib/prFixLoop';
import { prFixLoopApi, type PrFixLoopTarget } from '@/lib/prFixLoopApi';
import { readSpacesSwitch } from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { PrFixLoopSpacesSetup } from './PrFixLoopSpacesSetup';
import { PrFixLoopWorkerPreparation } from './PrFixLoopWorkerPreparation';
import { PrFixLoopWorkerStatus } from './PrFixLoopWorkerStatus';
import { PrFixLoopGitSetup } from './PrFixLoopGitSetup';

export type WorkerSelection = { readonly worker: FixLoopWorker | null; readonly ready: boolean };

export function PrFixLoopWorkerSetup({ target, onSelect }: {
  readonly target: PrFixLoopTarget;
  readonly onSelect: (selection: WorkerSelection) => void;
}) {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const [setup, setSetup] = React.useState(false);
  const [workers, setWorkers] = React.useState<readonly FixLoopWorker[]>([]);
  const [selectedId, setSelectedId] = React.useState('');
  const [readState, setReadState] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = React.useState(0);
  const [forgetting, setForgetting] = React.useState(false);
  const workerRevision = React.useRef(0);
  const worker = workers.find((entry) => entry.id === selectedId) ?? null;
  const entry = useSpacesStore((state) => worker ? state.journey?.get(worker.spaceId) : undefined);
  const ready = enabled && readState === 'ready' && isFixLoopWorkerReady(worker, entry, { sessionId: target.sessionId, directory: target.context.directory });
  React.useEffect(() => onSelect({ worker, ready }), [onSelect, ready, worker]);
  React.useEffect(() => {
    const controller = new AbortController();
    const baseline = workerRevision.current;
    setReadState('loading');
    const read = async () => {
      const answer = await readSpacesSwitch(controller.signal);
      if (controller.signal.aborted) return;
      useUIStore.getState().setIsolatedSpacesEnabled(answer.enabled);
      if (answer.enabled) {
        const [prepared] = await Promise.all([prFixLoopApi.listWorkers(controller.signal), refreshSpacesJourney()]);
        if (controller.signal.aborted) return;
        if (baseline === workerRevision.current) setWorkers(prepared);
      }
      setReadState('ready');
    };
    void read().catch(() => { if (!controller.signal.aborted) setReadState('failed'); });
    return () => controller.abort();
  }, [revision]);
  const candidates = workers.filter((entry) => entry.parentSessionId === target.sessionId && entry.directory === target.context.directory);
  const prepared = (created: FixLoopWorker) => {
    workerRevision.current += 1;
    setWorkers((current) => [...current, created]);
    setSelectedId(created.id);
    void refreshSpacesJourney().catch((error) => { if (!(error instanceof Error)) throw error; setReadState('failed'); });
  };
  const forget = async () => {
    if (!worker || forgetting) return;
    setForgetting(true);
    try {
      await prFixLoopApi.forgetWorker(worker.id);
      workerRevision.current += 1;
      setWorkers((current) => current.filter((entry) => entry.id !== worker.id));
      setSelectedId('');
    } catch (error) { if (!(error instanceof Error)) throw error; setReadState('failed'); }
    finally { setForgetting(false); }
  };

  return <section className="min-w-0 space-y-4 border-t border-border/60 pt-4" aria-label={t('prFixLoop.worker.title')}>
    <div className="space-y-2">
      <h3 className="typography-ui-label font-medium">{t('prFixLoop.worker.title')}</h3>
      <p className="typography-meta text-muted-foreground">{t('prFixLoop.worker.description')}</p>
    </div>
    {!enabled ? <p className="typography-meta text-muted-foreground">{t('prFixLoop.worker.off')}</p> : null}
    <Button size="sm" variant="chip" aria-pressed={setup} onClick={() => setSetup((value) => !value)}>{t('prFixLoop.worker.setup')}</Button>
    <PrFixLoopGitSetup directory={target.context.directory} />
    {readState === 'loading' ? <p role="status" className="typography-meta text-muted-foreground">{t('prFixLoop.loading')}</p> : null}
    {readState === 'failed' ? <p role="alert" className="typography-meta text-status-warning">{t('prFixLoop.worker.unknown')}</p> : null}
    {enabled ? <>
      {candidates.length ? <SettingsStackedField label={t('prFixLoop.worker.selection')}>
        <Select value={selectedId} disabled={forgetting} onValueChange={(value) => setSelectedId(value ?? '')}>
          <SelectTrigger aria-label={t('prFixLoop.worker.selection')}><SelectValue placeholder={t('prFixLoop.worker.new')}>
            {worker ? `${worker.spaceId} · ${worker.model.providerID}/${worker.model.modelID}` : t('prFixLoop.worker.new')}
          </SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('prFixLoop.worker.new')}</SelectItem>
            {candidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.spaceId} · {candidate.model.providerID}/{candidate.model.modelID}</SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsStackedField> : null}
      {worker ? <>
        <PrFixLoopWorkerStatus worker={worker} showRefresh={false} />
        <p role="status" className={ready ? 'typography-meta text-muted-foreground' : 'typography-meta text-status-warning'}>{t(ready ? 'prFixLoop.worker.ready' : 'prFixLoop.worker.blocked')}</p>
        <Button size="sm" variant="ghost" disabled={forgetting} onClick={() => void forget()}>{t('prFixLoop.worker.forget')}</Button>
        <p className="typography-meta text-muted-foreground">{t('prFixLoop.worker.retained')}</p>
      </> : readState === 'ready' ? <PrFixLoopWorkerPreparation target={target} onPrepared={prepared} /> : null}
    </> : null}
    <Button size="sm" variant="ghost" disabled={readState === 'loading'} onClick={() => setRevision((value) => value + 1)}>{t('spaces.access.blocked.refresh')}</Button>
    <PrFixLoopSpacesSetup open={setup} onClose={() => { setSetup(false); setRevision((value) => value + 1); }} />
  </section>;
}
