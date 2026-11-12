import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { listModelVariantIds } from '@/lib/modelVariants';
import { APPROVAL_WORKER_PROVIDERS, fixLoopWorkerModelSchema, type FixLoopWorker, type FixLoopWorkerModel } from '@/lib/prFixLoop';
import { prFixLoopApi, type PrFixLoopTarget } from '@/lib/prFixLoopApi';
import { listSpacePlaces, type SpacePlace } from '@/lib/spaces/spaces-api';
import { isRootPlace, orderedSpacePlaces, spacePlaceName } from '@/lib/spaces/space-places';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';

type Places = { readonly state: 'loading' } | { readonly state: 'ready'; readonly places: readonly SpacePlace[] } | { readonly state: 'failed' };

/** An explicit model and place choice prepares a fresh space. Access is granted separately. */
export function PrFixLoopWorkerPreparation({ target, onPrepared }: {
  readonly target: PrFixLoopTarget;
  readonly onPrepared: (worker: FixLoopWorker) => void;
}) {
  const { t } = useI18n();
  const [places, setPlaces] = React.useState<Places>({ state: 'loading' });
  const [revision, setRevision] = React.useState(0);
  const [placeId, setPlaceId] = React.useState('');
  const [name, setName] = React.useState(`pr-${target.number}`);
  const [model, setModel] = React.useState<FixLoopWorkerModel>({ providerID: '', modelID: '' });
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    setPlaces({ state: 'loading' });
    listSpacePlaces(controller.signal).then(
      (answer) => { if (!controller.signal.aborted) setPlaces({ state: 'ready', places: orderedSpacePlaces(answer).filter((place) => !isRootPlace(place)) }); },
      () => { if (!controller.signal.aborted) setPlaces({ state: 'failed' }); },
    );
    return () => controller.abort();
  }, [revision]);
  const catalog = useConfigStore((state) => selectProvidersForDirectory(state, target.context.directory));
  const selectedModel = catalog.find((provider) => provider.id === model.providerID)?.models.find((entry) => entry.id === model.modelID);
  const variants = listModelVariantIds(selectedModel?.variants);
  const place = places.state === 'ready' ? places.places.find((entry) => entry.id === placeId) : undefined;
  const canPrepare = !busy && place?.available === true && place.hostIsolation && name.trim() !== '' && fixLoopWorkerModelSchema.safeParse(model).success;
  const prepare = async () => {
    if (!canPrepare) return;
    setBusy(true);
    setFailed(false);
    try {
      const worker = await prFixLoopApi.prepareWorker({ ...target, name: name.trim(), placeId, model });
      if (alive.current) onPrepared(worker);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (alive.current) setFailed(true);
    } finally { if (alive.current) setBusy(false); }
  };

  return <div className="space-y-4">
    <SettingsStackedField label={t('spaces.create.name.label')}>
      <Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} aria-label={t('spaces.create.name.label')} />
    </SettingsStackedField>
    <SettingsStackedField label={t('spaces.create.place.label')}>
      <Select value={placeId} disabled={busy || places.state !== 'ready'} onValueChange={(value) => { if (value) setPlaceId(value); }}>
        <SelectTrigger aria-label={t('spaces.create.place.label')}><SelectValue placeholder={t('prFixLoop.worker.choosePlace')}>
          {place ? spacePlaceName(t, place) : null}
        </SelectValue></SelectTrigger>
        <SelectContent>{places.state === 'ready' ? places.places.map((entry) => <SelectItem key={entry.id} value={entry.id} disabled={!entry.available || !entry.hostIsolation}>
          {spacePlaceName(t, entry)}
        </SelectItem>) : null}</SelectContent>
      </Select>
      {places.state === 'loading' ? <p role="status" className="typography-meta text-muted-foreground">{t('spaces.place.checking')}</p> : null}
      {places.state === 'failed' || (places.state === 'ready' && !places.places.some((entry) => entry.available && entry.hostIsolation)) ?
        <p role="alert" className="typography-meta text-status-warning">{t('prFixLoop.worker.placeUnavailable')}</p> : null}
      {place?.machine ? <p className="typography-meta text-status-warning">{t('spaces.create.place.keysOnMachine', { machine: place.machine })}</p> : null}
      <Button size="sm" variant="ghost" disabled={busy || places.state === 'loading'} onClick={() => setRevision((value) => value + 1)}>{t('spaces.access.blocked.refresh')}</Button>
    </SettingsStackedField>
    <SettingsStackedField label={t('chat.modelControls.model')}>
      <div inert={busy}>
        <ModelSelector directory={target.context.directory} providerId={model.providerID} modelId={model.modelID}
          allowedProviderIds={APPROVAL_WORKER_PROVIDERS} placeholder={t('settings.agents.modelSelector.notSelected')}
          onChange={(providerID, modelID) => setModel({ providerID, modelID })} />
      </div>
    </SettingsStackedField>
    {variants.length ? <SettingsStackedField label={t('sessions.scheduledTasks.editor.thinkingLevel.label')}>
      <Select value={model.variant ?? ''} disabled={busy} onValueChange={(value) => setModel((current) => ({ ...current, variant: value || undefined }))}>
        <SelectTrigger aria-label={t('sessions.scheduledTasks.editor.thinkingLevel.label')}><SelectValue>{model.variant || t('rightSidebar.contextNotesTodo.sendDialog.variant.default')}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="">{t('rightSidebar.contextNotesTodo.sendDialog.variant.default')}</SelectItem>
          {variants.map((variant) => <SelectItem key={variant} value={variant}>{variant}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsStackedField> : null}
    {failed ? <p role="alert" className="typography-meta text-status-error">{t('prFixLoop.worker.prepareFailed')}</p> : null}
    <Button variant="outline" size="sm" disabled={!canPrepare} aria-busy={busy} onClick={() => void prepare()}>
      {t(busy ? 'prFixLoop.worker.preparing' : 'prFixLoop.worker.prepare')}
    </Button>
  </div>;
}
