import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SETTINGS_HELPER_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { fetchModelRoutes } from '@/lib/routing/modelRoutesApi';
import {
  NOTE_KINDS,
  PLAN_COVERAGE,
  PLAN_PERIODS,
  PLAN_STATUSES,
  PLAN_TIERS,
  PLAN_UNITS,
  addPlanNote,
  fetchPlanState,
  savePlanRecord,
  savePoolPurpose,
  saveModelTier,
  type NoteKind,
  type PlanCoverage,
  type PlanFee,
  type PlanNote,
  type PlanPeriod,
  type PlanRecord,
  type PlanState,
  type PlanStatus,
  type PlanTier,
  type PlanUnit,
  type QuotaWindow,
} from '@/lib/routing/plansApi';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim());

const listOf = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

type ActionSendMode = 'prefill' | 'autosend';
const ACTION_SEND_MODE_STORAGE_KEY = 'openchamber.routing.plans.actionSendMode';

/** Starts a new chat and either prefills the command or sends it immediately. */
const startCommand = async (command: string, title: string, failed: string, mode: ActionSendMode = 'prefill') => {
  const session = await useSessionUIStore.getState().createSession(title);
  if (!session) {
    toast.error(failed);
    return;
  }
  if (mode === 'autosend') {
    void useSessionUIStore.getState().sendMessage(`/${command}`, '', '');
  } else {
    useInputStore.getState().setPendingInputText(`/${command}`, 'replace');
  }
};

interface QuotaDraft {
  name: string;
  unit: PlanUnit;
  limit: string;
  windowHours: string;
  resetRule: string;
}

interface PlanDraft {
  label: string;
  plan: string;
  coverage: PlanCoverage;
  status: PlanStatus;
  feeAmount: string;
  feeCurrency: string;
  feePeriod: PlanPeriod;
  expiresOn: string;
  verifiedAt: string;
  verifiedFrom: string;
  details: string;
  quotas: QuotaDraft[];
}

const draftOf = (plan: PlanRecord): PlanDraft => ({
  label: plan.label,
  plan: plan.plan ?? '',
  coverage: plan.coverage,
  status: plan.status,
  feeAmount: plan.fee ? String(plan.fee.amount) : '',
  feeCurrency: plan.fee?.currency ?? 'USD',
  feePeriod: plan.fee?.period ?? 'monthly',
  expiresOn: plan.expiresOn ?? '',
  verifiedAt: plan.verifiedAt ?? '',
  verifiedFrom: plan.verifiedFrom ?? '',
  details: plan.notes ?? '',
  quotas: plan.quotas.map((window) => ({
    name: window.name,
    unit: window.unit,
    limit: window.limit === undefined ? '' : String(window.limit),
    windowHours: window.windowHours === undefined ? '' : String(window.windowHours),
    resetRule: window.resetRule ?? '',
  })),
});

const quotaPayload = (window: QuotaDraft): QuotaWindow => ({
  name: window.name.trim(),
  unit: window.unit,
  ...(window.limit.trim() === '' ? {} : { limit: Number(window.limit) }),
  ...(window.windowHours.trim() === '' ? {} : { windowHours: Number(window.windowHours) }),
  ...(window.resetRule.trim() === '' ? {} : { resetRule: window.resetRule.trim() }),
});

const feePayload = (draft: PlanDraft): PlanFee | null =>
  draft.feeAmount.trim() === ''
    ? null
    : { amount: Number(draft.feeAmount), currency: draft.feeCurrency.trim() || 'USD', period: draft.feePeriod };

const SelectField = <T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: readonly T[];
  label: (value: T) => string;
  onChange: (value: T) => void;
}) => (
  <Select value={value} onValueChange={(next) => onChange(next as T)}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {options.map((option) => (
        <SelectItem key={option} value={option}>
          {label(option)}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const PlanCard: React.FC<{
  plan: PlanRecord;
  onSaved: (plan: PlanRecord) => void;
}> = ({ plan, onSaved }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<PlanDraft>(() => draftOf(plan));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const update = (patch: Partial<PlanDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateQuota = (index: number, patch: Partial<QuotaDraft>) =>
    update({ quotas: draft.quotas.map((window, position) => (position === index ? { ...window, ...patch } : window)) });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await savePlanRecord({
        id: plan.id,
        providerID: plan.providerID,
        label: draft.label.trim() || plan.providerID,
        plan: blankToNull(draft.plan),
        coverage: draft.coverage,
        status: draft.status,
        fee: feePayload(draft),
        expiresOn: blankToNull(draft.expiresOn),
        verifiedAt: blankToNull(draft.verifiedAt),
        verifiedFrom: blankToNull(draft.verifiedFrom),
        notes: blankToNull(draft.details),
        quotas: draft.quotas.filter((window) => window.name.trim() !== '').map(quotaPayload),
      });
      onSaved(saved);
      toast.success(t('settings.routing.plans.saved'));
    } catch (failure) {
      setError(t('settings.routing.plans.saveFailed', { error: errorText(failure) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="typography-ui-label font-medium text-foreground">
          {plan.plan ? `${plan.providerID} · ${plan.plan}` : plan.label}
        </div>
        <div className={SETTINGS_HELPER_CLASS}>
          {plan.verifiedAt
            ? t('settings.routing.plans.verifiedOn', { date: plan.verifiedAt })
            : t('settings.routing.plans.neverVerified')}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={draft.label} placeholder={t('settings.routing.plans.label')} onChange={(event) => update({ label: event.target.value })} />
        <Input value={draft.plan} placeholder={t('settings.routing.plans.planName')} onChange={(event) => update({ plan: event.target.value })} />
        <SelectField
          value={draft.coverage}
          options={PLAN_COVERAGE}
          label={(value) => t(`settings.routing.plans.coverage.${value}`)}
          onChange={(coverage) => update({ coverage })}
        />
        <SelectField
          value={draft.status}
          options={PLAN_STATUSES}
          label={(value) => t(`settings.routing.plans.status.${value}`)}
          onChange={(status) => update({ status })}
        />
        <div className="flex gap-2">
          <Input value={draft.feeAmount} inputMode="decimal" placeholder={t('settings.routing.plans.feeAmount')} onChange={(event) => update({ feeAmount: event.target.value })} />
          <Input value={draft.feeCurrency} className="w-24" placeholder={t('settings.routing.plans.feeCurrency')} onChange={(event) => update({ feeCurrency: event.target.value })} />
        </div>
        <SelectField
          value={draft.feePeriod}
          options={PLAN_PERIODS}
          label={(value) => t(`settings.routing.plans.period.${value}`)}
          onChange={(feePeriod) => update({ feePeriod })}
        />
        <label className="flex flex-col gap-1">
          <span className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.expiresOn')}</span>
          <Input type="date" value={draft.expiresOn} onChange={(event) => update({ expiresOn: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.verifiedAt')}</span>
          <Input type="date" value={draft.verifiedAt} onChange={(event) => update({ verifiedAt: event.target.value })} />
        </label>
        <Input value={draft.verifiedFrom} placeholder={t('settings.routing.plans.verifiedFrom')} onChange={(event) => update({ verifiedFrom: event.target.value })} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="typography-ui-label text-foreground">{t('settings.routing.plans.quotas')}</div>
        {draft.quotas.map((window, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_8rem_6rem_6rem_1fr_auto]">
            <Input value={window.name} placeholder={t('settings.routing.plans.quota.name')} onChange={(event) => updateQuota(index, { name: event.target.value })} />
            <SelectField value={window.unit} options={PLAN_UNITS} label={(value) => value} onChange={(unit) => updateQuota(index, { unit })} />
            <Input value={window.limit} inputMode="decimal" placeholder={t('settings.routing.plans.quota.limit')} onChange={(event) => updateQuota(index, { limit: event.target.value })} />
            <Input value={window.windowHours} inputMode="decimal" placeholder={t('settings.routing.plans.quota.hours')} onChange={(event) => updateQuota(index, { windowHours: event.target.value })} />
            <Input value={window.resetRule} placeholder={t('settings.routing.plans.quota.reset')} onChange={(event) => updateQuota(index, { resetRule: event.target.value })} />
            <Button variant="ghost" size="sm" onClick={() => update({ quotas: draft.quotas.filter((_, position) => position !== index) })}>
              {t('settings.routing.plans.quota.remove')}
            </Button>
          </div>
        ))}
        <div>
          <Button variant="outline" size="sm" onClick={() => update({ quotas: [...draft.quotas, { name: '', unit: 'messages', limit: '', windowHours: '', resetRule: '' }] })}>
            {t('settings.routing.plans.quota.add')}
          </Button>
        </div>
      </div>

      <Textarea value={draft.details} rows={3} placeholder={t('settings.routing.plans.details')} onChange={(event) => update({ details: event.target.value })} />
      {plan.howToCheck ? <div className={SETTINGS_HELPER_CLASS}>{plan.howToCheck}</div> : null}
      <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.howToCheck')}</div>
      {error ? <div className="typography-ui-label text-status-error">{error}</div> : null}
      <div className="flex justify-end">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {t('settings.routing.plans.save')}
        </Button>
      </div>
    </div>
  );
};

const ModelTierRow: React.FC<{
  model: string;
  tier: PlanTier;
  coveredBy: readonly string[];
  onSaved: (model: string, tier: PlanTier, coveredBy: string[]) => void;
}> = ({ model, tier, coveredBy, onSaved }) => {
  const { t } = useI18n();
  const [nextTier, setNextTier] = React.useState<PlanTier>(tier);
  const [covered, setCovered] = React.useState(coveredBy.join(', '));
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveModelTier({ model, tier: nextTier, coveredBy: listOf(covered) });
      onSaved(model, saved.tier, saved.coveredBy ?? []);
      toast.success(t('settings.routing.plans.saved'));
    } catch (failure) {
      toast.error(t('settings.routing.plans.saveFailed', { error: errorText(failure) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid items-center gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
      <div className="typography-ui-label truncate text-foreground">{model}</div>
      <SelectField value={nextTier} options={PLAN_TIERS} label={(value) => t(`settings.routing.plans.tier.${value}`)} onChange={setNextTier} />
      <Input value={covered} placeholder={t('settings.routing.plans.models.coveredBy')} onChange={(event) => setCovered(event.target.value)} />
      <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
        {t('settings.routing.plans.save')}
      </Button>
    </div>
  );
};

const PoolPurposeRow: React.FC<{
  poolID: string;
  tier?: PlanTier;
  purpose?: string;
  onSaved: (poolID: string, tier: PlanTier | undefined, purpose: string | undefined) => void;
}> = ({ poolID, tier, purpose, onSaved }) => {
  const { t } = useI18n();
  const [nextTier, setNextTier] = React.useState<PlanTier>(tier ?? 'standard');
  const [text, setText] = React.useState(purpose ?? '');
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await savePoolPurpose({ id: poolID, tier: nextTier, purpose: blankToNull(text) });
      onSaved(poolID, saved.tier, saved.purpose);
      toast.success(t('settings.routing.plans.saved'));
    } catch (failure) {
      toast.error(t('settings.routing.plans.saveFailed', { error: errorText(failure) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid items-center gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
      <div className="typography-ui-label truncate text-foreground">opencode-route/{poolID}</div>
      <SelectField value={nextTier} options={PLAN_TIERS} label={(value) => t(`settings.routing.plans.tier.${value}`)} onChange={setNextTier} />
      <Input value={text} placeholder={t('settings.routing.plans.pools.purpose')} onChange={(event) => setText(event.target.value)} />
      <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
        {t('settings.routing.plans.save')}
      </Button>
    </div>
  );
};

const NoteList: React.FC<{ notes: readonly PlanNote[] }> = ({ notes }) => {
  const { t } = useI18n();
  if (notes.length === 0) return <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.notes.empty')}</div>;
  return (
    <ul className="flex flex-col gap-2">
      {[...notes].reverse().map((note) => (
        <li key={note.id} className="flex flex-col gap-0.5 rounded-md border border-border/50 p-2">
          <div className={SETTINGS_HELPER_CLASS}>
            {note.at.slice(0, 10)} · {t(`settings.routing.plans.notes.kind.${note.kind}`)}
            {note.providerID ? ` · ${note.providerID}` : ''}
            {note.modelID ? ` · ${note.modelID}` : ''}
            {note.poolID ? ` · opencode-route/${note.poolID}` : ''}
            {note.source === 'model' ? ` · ${t('settings.routing.plans.notes.fromModel')}` : ''}
          </div>
          <div className="typography-ui-label whitespace-pre-wrap text-foreground">{note.text}</div>
        </li>
      ))}
    </ul>
  );
};

/** Plans, model cost tiers, pool purposes and notes, with the two buttons that start a review or an update. */
export const PlansSection: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = React.useState<PlanState | null>(null);
  const [pools, setPools] = React.useState<Record<string, { tier?: PlanTier; purpose?: string }>>({});
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionSendMode, setActionSendMode] = React.useState<ActionSendMode>(() => {
    try {
      const saved = localStorage.getItem(ACTION_SEND_MODE_STORAGE_KEY);
      return saved === 'autosend' ? 'autosend' : 'prefill';
    } catch {
      return 'prefill';
    }
  });

  const handleActionSendModeChange = (mode: ActionSendMode) => {
    setActionSendMode(mode);
    try {
      localStorage.setItem(ACTION_SEND_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage error
    }
  };
  const [newProvider, setNewProvider] = React.useState('');
  const [newPlanName, setNewPlanName] = React.useState('');
  const [newModel, setNewModel] = React.useState('');
  const [newModelTier, setNewModelTier] = React.useState<PlanTier>('standard');
  const [noteText, setNoteText] = React.useState('');
  const [noteKind, setNoteKind] = React.useState<NoteKind>('experience');
  const [noteProvider, setNoteProvider] = React.useState('');
  const [addingNote, setAddingNote] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [planState, routes] = await Promise.all([fetchPlanState(), fetchModelRoutes().catch(() => null)]);
      setState(planState);
      // The pools page edits only the user file's pools; this page lists every
      // pool OpenCode applies, so it adds the pools held in other files.
      const poolIDs = new Set([
        ...Object.keys(routes?.routes ?? {}),
        ...(routes?.otherRoutes ?? []).flatMap((file) => Object.keys(file.routes)),
      ]);
      setPools(Object.fromEntries([...poolIDs].map((id) => [id, planState.pools[id] ?? {}])));
      setLoadError(null);
    } catch (failure) {
      setLoadError(t('settings.routing.plans.loadFailed', { error: errorText(failure) }));
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const replacePlan = (plan: PlanRecord) =>
    setState((current) =>
      current
        ? {
            ...current,
            plans: current.plans.some((item) => item.id === plan.id)
              ? current.plans.map((item) => (item.id === plan.id ? plan : item))
              : [...current.plans, plan],
          }
        : current,
    );

  const addPlan = async () => {
    if (newProvider.trim() === '') return;
    try {
      const plan = await savePlanRecord({
        providerID: newProvider.trim(),
        ...(newPlanName.trim() === '' ? {} : { plan: newPlanName.trim() }),
        label: newProvider.trim(),
      });
      replacePlan(plan);
      setNewProvider('');
      setNewPlanName('');
      toast.success(t('settings.routing.plans.saved'));
    } catch (failure) {
      toast.error(t('settings.routing.plans.saveFailed', { error: errorText(failure) }));
    }
  };

  const addModel = async () => {
    if (newModel.trim() === '' || !newModel.includes('/')) return;
    try {
      const saved = await saveModelTier({ model: newModel.trim(), tier: newModelTier });
      setState((current) =>
        current ? { ...current, models: { ...current.models, [newModel.trim()]: saved } } : current,
      );
      setNewModel('');
      toast.success(t('settings.routing.plans.saved'));
    } catch (failure) {
      toast.error(t('settings.routing.plans.saveFailed', { error: errorText(failure) }));
    }
  };

  const addNote = async () => {
    if (noteText.trim() === '') return;
    setAddingNote(true);
    try {
      const note = await addPlanNote({
        text: noteText.trim(),
        kind: noteKind,
        ...(noteProvider.trim() === '' ? {} : { providerID: noteProvider.trim() }),
      });
      setState((current) => (current ? { ...current, notes: [...current.notes, note] } : current));
      setNoteText('');
      toast.success(t('settings.routing.plans.saved'));
    } catch (failure) {
      toast.error(t('settings.routing.plans.saveFailed', { error: errorText(failure) }));
    } finally {
      setAddingNote(false);
    }
  };

  return (
    <SettingsSection
      title={t('settings.routing.plans.title')}
      description={t('settings.routing.plans.description')}
      settingsItem="routing.plans"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex flex-1 flex-col gap-1">
            <Button size="sm" onClick={() => void startCommand('routing-review', t('settings.routing.plans.reviewTitle'), t('settings.routing.plans.commandFailed'), actionSendMode)}>
              {t('settings.routing.plans.review')}
            </Button>
            <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.reviewHint')}</div>
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Button size="sm" variant="outline" onClick={() => void startCommand('plan-update', t('settings.routing.plans.updateTitle'), t('settings.routing.plans.commandFailed'), actionSendMode)}>
              {t('settings.routing.plans.update')}
            </Button>
            <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.updateHint')}</div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-border/40 pb-3">
          <div className="flex flex-col gap-0.5">
            <div className="typography-ui-label font-medium text-foreground">{t('settings.routing.plans.actionSendMode')}</div>
            <div className={SETTINGS_HELPER_CLASS}>
              {actionSendMode === 'autosend'
                ? t('settings.routing.plans.actionSendMode.autosend')
                : t('settings.routing.plans.actionSendMode.prefill')}
            </div>
          </div>
          <div className="w-56">
            <SelectField
              value={actionSendMode}
              options={['prefill', 'autosend'] as const}
              label={(m) => t(`settings.routing.plans.actionSendMode.${m}`)}
              onChange={handleActionSendModeChange}
            />
          </div>
        </div>

        {loadError ? <div className="typography-ui-label text-status-error">{loadError}</div> : null}

        <div className="flex flex-col gap-3">
          <div className="typography-ui-label font-medium text-foreground">{t('settings.routing.plans.plansTitle')}</div>
          {state && state.plans.length === 0 ? <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.empty')}</div> : null}
          {state?.plans.map((plan) => (
            <PlanCard key={`${plan.id}:${plan.updatedAt}`} plan={plan} onSaved={replacePlan} />
          ))}
          <div className="grid items-center gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input value={newProvider} placeholder={t('settings.routing.plans.addProvider')} onChange={(event) => setNewProvider(event.target.value)} />
            <Input value={newPlanName} placeholder={t('settings.routing.plans.addName')} onChange={(event) => setNewPlanName(event.target.value)} />
            <Button size="sm" variant="outline" onClick={() => void addPlan()}>
              {t('settings.routing.plans.add')}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="typography-ui-label font-medium text-foreground">{t('settings.routing.plans.models.title')}</div>
          <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.models.description')}</div>
          {Object.entries(state?.models ?? {}).map(([model, entry]) => (
            <ModelTierRow
              key={`${model}:${entry.updatedAt}`}
              model={model}
              tier={entry.tier}
              coveredBy={entry.coveredBy ?? []}
              onSaved={(saved, tier, coveredBy) =>
                setState((current) =>
                  current ? { ...current, models: { ...current.models, [saved]: { ...current.models[saved], tier, coveredBy } } } : current,
                )
              }
            />
          ))}
          <div className="grid items-center gap-2 sm:grid-cols-[1fr_9rem_auto]">
            <Input value={newModel} placeholder={t('settings.routing.plans.models.model')} onChange={(event) => setNewModel(event.target.value)} />
            <SelectField value={newModelTier} options={PLAN_TIERS} label={(value) => t(`settings.routing.plans.tier.${value}`)} onChange={setNewModelTier} />
            <Button size="sm" variant="outline" onClick={() => void addModel()}>
              {t('settings.routing.plans.models.add')}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="typography-ui-label font-medium text-foreground">{t('settings.routing.plans.pools.title')}</div>
          {Object.keys(pools).length === 0 ? <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.pools.empty')}</div> : null}
          {Object.keys(pools).map((poolID) => (
            <PoolPurposeRow
              key={`${poolID}:${state?.pools[poolID]?.updatedAt ?? ''}`}
              poolID={poolID}
              tier={pools[poolID]?.tier}
              purpose={pools[poolID]?.purpose}
              onSaved={(id, tier, purpose) => setPools((current) => ({ ...current, [id]: { tier, purpose } }))}
            />
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="typography-ui-label font-medium text-foreground">{t('settings.routing.plans.notes.title')}</div>
          <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.notes.description')}</div>
          <NoteList notes={state?.notes ?? []} />
          <Textarea value={noteText} rows={3} placeholder={t('settings.routing.plans.notes.text')} onChange={(event) => setNoteText(event.target.value)} />
          <div className="grid items-center gap-2 sm:grid-cols-[12rem_1fr_auto]">
            <SelectField value={noteKind} options={NOTE_KINDS} label={(value) => t(`settings.routing.plans.notes.kind.${value}`)} onChange={setNoteKind} />
            <Input value={noteProvider} placeholder={t('settings.routing.plans.notes.provider')} onChange={(event) => setNoteProvider(event.target.value)} />
            <Button size="sm" disabled={addingNote} onClick={() => void addNote()}>
              {t('settings.routing.plans.notes.add')}
            </Button>
          </div>
          {state?.skippedNotes ? (
            <div className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.notes.skipped', { count: state.skippedNotes })}</div>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
};
