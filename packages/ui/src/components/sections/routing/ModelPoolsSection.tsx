import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AUTONOMY_LEVELS,
  POOL_DETAILS_MAX_LENGTH,
  fetchModelRoutes,
  fetchRouteStats,
  saveModelRouteSchedules,
  saveModelRouteTuning,
  saveModelRoutes,
  type HedgeAccuracy,
  type ModelRoute,
  type ModelRouteTuning,
  type RouteErrorGroup,
  type RouteTargetStats,
} from '@/lib/routing/modelRoutesApi';
import { PoolAdvancedFields } from '@/components/sections/routing/PoolAdvancedFields';
import { PoolHealthSection } from '@/components/sections/routing/PoolHealthSection';
import { CommitInput, PoolTargetOptions } from '@/components/sections/routing/PoolTargetOptions';
import { RouteScheduleFields } from '@/components/sections/routing/RouteScheduleFields';
import type { ScheduleList, ScheduleListValue, StoredSchedules } from '@/lib/routing/scheduleSchema';
import { RouteTuningFields } from '@/components/sections/routing/RouteTuningFields';
import { fetchWaitEstimate, type WaitEstimate } from '@/lib/routing/routeRulesApi';
import { PRESET_ROUTE_IDS, presetTargets, type PresetId } from '@/lib/routing/routePresets';
import { pickedAutonomy, routeReference, routeReferenceID, targetLabel, targetUntil, withoutAbsentWeights } from '@/lib/routing/poolAdvanced';
import { useConfigStore } from '@/stores/useConfigStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';

const PRESETS = [
  { id: 'cheap', titleKey: 'settings.pools.preset.cheap', infoKey: 'settings.pools.preset.cheapInfo' },
  { id: 'fast', titleKey: 'settings.pools.preset.fast', infoKey: 'settings.pools.preset.fastInfo' },
  { id: 'sturdy', titleKey: 'settings.pools.preset.sturdy', infoKey: 'settings.pools.preset.sturdyInfo' },
] as const;

type RouteTarget = NonNullable<ModelRoute['targets']>[number];

/** The concrete provider and model of a target, or null for a pattern or another pool. */
const concreteTarget = (target: RouteTarget): { providerID: string; modelID: string } | null => {
  if (routeReferenceID(target) !== null) return null;
  const [ref] = targetLabel(target).split('#');
  const slash = ref.indexOf('/');
  if (slash <= 0) return null;
  const modelID = ref.slice(slash + 1);
  if (modelID.includes('*')) return null;
  return { providerID: ref.slice(0, slash), modelID };
};

const TargetWait: React.FC<{ providerID: string; modelID: string }> = ({ providerID, modelID }) => {
  const { t } = useI18n();
  const [estimate, setEstimate] = React.useState<WaitEstimate | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchWaitEstimate(providerID, modelID)
      .then((next) => {
        if (!cancelled) setEstimate(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [providerID, modelID]);

  if (!estimate) return null;
  if (estimate.active) {
    return (
      <span className="typography-meta text-muted-foreground">
        {t('settings.pools.wait.cooling', { minutes: Math.ceil(estimate.active.remainingMs / 60_000) })}
      </span>
    );
  }
  if (estimate.expectedMs === null) {
    return <span className="typography-meta text-muted-foreground">{t('settings.pools.wait.none')}</span>;
  }
  return (
    <span className="typography-meta text-muted-foreground">
      {t('settings.pools.wait.expected', { minutes: Math.ceil(estimate.expectedMs / 60_000) })}
    </span>
  );
};

/** A paragraph field that saves when it loses focus, like `CommitInput` does for one line. */
const CommitTextarea: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}> = ({ label, value, placeholder, onCommit }) => {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Textarea
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      maxLength={POOL_DETAILS_MAX_LENGTH}
      rows={3}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next !== value) onCommit(next);
      }}
      className="w-full"
    />
  );
};

/** One pool: what it is for, its targets, its autonomy level, and an expert JSON view. */
const PoolRow: React.FC<{
  id: string;
  route: ModelRoute;
  otherPoolIDs: string[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (route: ModelRoute) => void;
  onRemove: () => void;
}> = ({ id, route, otherPoolIDs, expanded, onToggle, onChange, onRemove }) => {
  const { t } = useI18n();
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [pattern, setPattern] = React.useState('');
  const [patternUntil, setPatternUntil] = React.useState('');
  const [jsonText, setJsonText] = React.useState<string | null>(null);
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const targets = route.targets ?? [];
  const addTarget = () => {
    if (!providerId || !modelId) return;
    const ref = `${providerId}/${modelId}`;
    if (targets.some((entry) => targetLabel(entry) === ref)) return;
    onChange({ ...route, targets: [...targets, ref] });
    setProviderId('');
    setModelId('');
  };

  const addPattern = () => {
    const model = pattern.trim();
    if (!model || targets.some((entry) => targetLabel(entry) === model)) return;
    const until = patternUntil ? new Date(patternUntil).getTime() : Number.NaN;
    const entry: RouteTarget = Number.isFinite(until) ? { model, until } : model;
    onChange({ ...route, targets: [...targets, entry] });
    setPattern('');
    setPatternUntil('');
  };

  const applyJson = () => {
    if (jsonText === null) return;
    try {
      const parsed = JSON.parse(jsonText) as ModelRoute;
      if (!parsed || !Array.isArray(parsed.targets)) throw new Error('targets must be an array');
      setJsonError(null);
      setJsonText(null);
      onChange(parsed);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="py-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-start hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="typography-ui-label font-medium text-foreground truncate">
            {route.name || id}
          </span>
          <span className="typography-meta text-muted-foreground truncate" title={route.description}>
            {t('settings.pools.targetCount', { count: targets.length })}
            {route.autonomy ? ` · ${route.autonomy}` : ''}
            {route.description ? ` · ${route.description}` : ''}
          </span>
        </button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('settings.pools.remove')}
        </Button>
      </div>
      {expanded ? (
        <div className="space-y-4 px-1 pb-4 pt-2">
          <SettingsStackedField label={t('settings.pools.name')} info={t('settings.pools.nameInfo')} controlClassName="max-w-none">
            <CommitInput
              label={t('settings.pools.name')}
              value={route.name ?? ''}
              placeholder={id}
              onCommit={(next) => onChange({ ...route, name: next || undefined })}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.pools.poolDescription')} info={t('settings.pools.poolDescriptionInfo')} controlClassName="max-w-none">
            <CommitInput
              label={t('settings.pools.poolDescription')}
              value={route.description ?? ''}
              placeholder={t('settings.pools.poolDescriptionPlaceholder')}
              onCommit={(next) => onChange({ ...route, description: next || undefined })}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.pools.poolDetails')} info={t('settings.pools.poolDetailsInfo')} controlClassName="max-w-none">
            <CommitTextarea
              label={t('settings.pools.poolDetails')}
              value={route.details ?? ''}
              placeholder={t('settings.pools.poolDetailsPlaceholder')}
              onCommit={(next) => onChange({ ...route, details: next || undefined })}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.pools.autonomy')} info={t('settings.pools.autonomyInfo')} controlClassName="max-w-none">
            <Select
              value={route.autonomy ?? '__unset__'}
              onValueChange={(next) => onChange({ ...route, autonomy: pickedAutonomy(next) })}
            >
              <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-full')} aria-label={t('settings.pools.autonomy')}>
                <SelectValue placeholder={t('settings.pools.autonomyDefault')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unset__">{t('settings.pools.autonomyDefault')}</SelectItem>
                {AUTONOMY_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`settings.pools.autonomy.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
          <p className={SETTINGS_HELPER_CLASS}>{t(`settings.pools.autonomyHelp.${route.autonomy ?? 'unset'}`)}</p>
          <div className="space-y-1" data-settings-item="routing.pools-targets">
            {targets.map((target, index) => {
              const until = targetUntil(target);
              const concrete = concreteTarget(target);
              const pool = routeReferenceID(target);
              return (
              <div key={`${targetLabel(target)}-${index}`} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="typography-ui-label min-w-0 flex-1 truncate">
                    {pool !== null ? `${t('settings.pools.targetPool')}: ${pool}` : targetLabel(target)}
                    {until !== undefined ? (
                      <span className="typography-meta text-muted-foreground">
                        {` · ${t('settings.pools.pattern.untilLabel', { time: new Date(until).toLocaleString() })}`}
                      </span>
                    ) : null}
                  </span>
                  {concrete ? <TargetWait providerID={concrete.providerID} modelID={concrete.modelID} /> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onChange({ ...route, targets: targets.filter((_, i) => i !== index) })}
                  >
                    {t('settings.pools.removeTarget')}
                  </Button>
                </div>
                <PoolTargetOptions
                  target={target}
                  onChange={(next) => onChange({ ...route, targets: targets.map((entry, i) => (i === index ? next : entry)) })}
                />
              </div>
              );
            })}
          </div>
          {otherPoolIDs.length > 0 ? (
            <SettingsStackedField label={t('settings.pools.addPoolTarget')} info={t('settings.pools.addPoolTargetInfo')} controlClassName="max-w-none">
              <Select
                value=""
                onValueChange={(next) => onChange({ ...route, targets: [...targets, routeReference(next)] })}
              >
                <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-full')} aria-label={t('settings.pools.addPoolTarget')}>
                  <SelectValue placeholder={t('settings.pools.addPoolTargetPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {otherPoolIDs.map((poolID) => (
                    <SelectItem key={poolID} value={poolID}>
                      {poolID}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsStackedField>
          ) : null}
          <SettingsStackedField label={t('settings.pools.pattern.label')} info={t('settings.pools.pattern.info')} controlClassName="max-w-none">
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
              <Input
                value={pattern}
                onChange={(event) => setPattern(event.target.value)}
                placeholder={t('settings.pools.pattern.placeholder')}
                aria-label={t('settings.pools.pattern.label')}
                className="h-8 min-w-0 flex-1 rounded-md px-3"
                maxLength={200}
              />
              <Input
                type="datetime-local"
                value={patternUntil}
                onChange={(event) => setPatternUntil(event.target.value)}
                aria-label={t('settings.pools.pattern.until')}
                title={t('settings.pools.pattern.untilInfo')}
                className="h-8 w-auto min-w-0 rounded-md px-2"
              />
              <Button size="sm" variant="outline" onClick={addPattern} disabled={!pattern.trim()}>
                {t('settings.pools.pattern.add')}
              </Button>
            </div>
          </SettingsStackedField>
          <div className="flex w-full min-w-0 items-center gap-2">
            <ModelSelector
              providerId={providerId}
              modelId={modelId}
              onChange={(nextProvider, nextModel) => {
                setProviderId(nextProvider);
                setModelId(nextModel);
              }}
              className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, 'w-full')}
              placeholder={t('settings.pools.addTargetPlaceholder')}
            />
            <Button size="sm" variant="outline" onClick={addTarget} disabled={!providerId || !modelId}>
              {t('settings.pools.addTarget')}
            </Button>
          </div>
          <div className="space-y-2">
            <Button size="sm" variant="ghost" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
              {advancedOpen ? t('settings.pools.advanced.hide') : t('settings.pools.advanced.show')}
            </Button>
            {advancedOpen ? <PoolAdvancedFields route={route} onChange={onChange} /> : null}
          </div>
          <SettingsStackedField label={t('settings.pools.expertJson')} info={t('settings.pools.expertJsonInfo')} controlClassName="max-w-none">
            <Textarea
              value={jsonText ?? JSON.stringify(route, null, 2)}
              onChange={(event) => setJsonText(event.target.value)}
              aria-label={t('settings.pools.expertJson')}
              rows={8}
              className="w-full font-mono text-xs"
              spellCheck={false}
            />
          </SettingsStackedField>
          {jsonError ? <p className={SETTINGS_HELPER_CLASS}>{jsonError}</p> : null}
          {jsonText !== null ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={applyJson}>
                {t('settings.pools.applyJson')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setJsonText(null); setJsonError(null); }}>
                {t('settings.pools.discardJson')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** Live telemetry from OpenCode's routing history: per-target performance, exact errors and hedge wins. */
const PoolTelemetry: React.FC = () => {
  const { t } = useI18n();
  const [stats, setStats] = React.useState<{
    targets: RouteTargetStats[];
    errors: RouteErrorGroup[];
    hedges: HedgeAccuracy[];
    windowHours?: number;
  } | null>(null);
  const [unavailable, setUnavailable] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchRouteStats()
      .then((state) => {
        if (cancelled) return;
        if (!state.available || !state.targets) {
          setUnavailable(state.reason ?? 'unknown');
          return;
        }
        setStats({ targets: state.targets, errors: state.errors ?? [], hedges: state.hedges ?? [], windowHours: state.windowHours });
      })
      .catch(() => {
        if (!cancelled) setUnavailable('unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unavailable) return null;
  if (!stats) return <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.telemetry.loading')}</p>;
  if (stats.targets.length === 0) return <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.telemetry.empty')}</p>;
  const hedgeRate = (row: HedgeAccuracy) =>
    row.hedges === 0 ? '—' : `${Math.round((row.wins / row.hedges) * 100)}% (${row.wins}/${row.hedges})`;
  const hedgeFor = (providerID: string, modelID: string) =>
    stats.hedges.find((row) => row.providerID === providerID && row.modelID === modelID);
  return (
    <div className="space-y-2">
      <p className={SETTINGS_HELPER_CLASS}>
        {t('settings.pools.telemetry.description', { hours: stats.windowHours ?? 24 })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-start typography-meta">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.target')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.attempts')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.failed')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.firstToken')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.hedgeWins')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {stats.targets.map((row) => {
              const hedge = hedgeFor(row.providerID, row.modelID);
              return (
                <tr key={`${row.providerID}/${row.modelID}`}>
                  <td className="py-1 pe-3 text-foreground truncate">{`${row.providerID}/${row.modelID}`}</td>
                  <td className="py-1 pe-3">{row.attempts}</td>
                  <td className="py-1 pe-3">{`${row.failures}${row.timeouts > 0 ? ` (${row.timeouts} timeouts)` : ''}`}</td>
                  <td className="py-1 pe-3">{row.avgFirstTokenMs === null ? '—' : `${row.avgFirstTokenMs}ms`}</td>
                  <td className="py-1 pe-3">{hedge ? hedgeRate(hedge) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {stats.errors.length > 0 ? (
        <div className="space-y-1">
          {stats.errors.slice(0, 8).map((error, index) => (
            <p key={index} className="typography-meta text-muted-foreground truncate">
              {`${error.providerID}/${error.modelID} ×${error.count}: ${error.tag ?? 'unknown'}${error.status ? ` ${error.status}` : ''}${error.lastMessage ? ` — ${error.lastMessage}` : ''}`}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** Model pools: beginner presets, per-pool autonomy, and an expert raw view. */
export const ModelPoolsSection: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const decisions = useRoutingStore((state) => state.decisions);
  const settingsDirectory = useSettingsDirectory();
  const [routes, setRoutes] = React.useState<Record<string, ModelRoute> | null>(null);
  const [available, setAvailable] = React.useState(true);
  const [drafts, setDrafts] = React.useState<Record<string, ModelRoute>>({});
  const [tuning, setTuning] = React.useState<ModelRouteTuning | null>(null);
  const [schedules, setSchedules] = React.useState<ScheduleList | null>(null);
  const [otherSchedules, setOtherSchedules] = React.useState<{ path: string; schedules: StoredSchedules }[]>([]);
  const [otherRoutes, setOtherRoutes] = React.useState<{ path: string; routes: Record<string, ModelRoute> }[]>([]);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [newId, setNewId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const lastSavedRef = React.useRef<Record<string, ModelRoute> | null>(null);
  const lastSavedSchedulesRef = React.useRef<ScheduleList | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchModelRoutes(settingsDirectory)
      .then((state) => {
        if (cancelled) return;
        // A server without /api/model-routes answers 404, which the API
        // layer reports as available: false rather than throwing. Without
        // this branch routes stays null and the section below shows its
        // Loading text forever.
        if (!state.available) {
          setAvailable(false);
          return;
        }
        lastSavedRef.current = state.routes;
        setRoutes(state.routes);
        setTuning(state.tuning ?? null);
        lastSavedSchedulesRef.current = state.schedules ?? null;
        setSchedules(state.schedules ?? null);
        setOtherSchedules(state.otherSchedules ?? []);
        setOtherRoutes(state.otherRoutes ?? []);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [settingsDirectory]);

  const persist = React.useCallback(async (next: Record<string, ModelRoute>) => {
    setRoutes(next);
    setSaving(true);
    try {
      const payload = Object.fromEntries(Object.entries(next).map(([id, route]) => [id, withoutAbsentWeights(route)]));
      const state = await saveModelRoutes(payload);
      lastSavedRef.current = state.routes;
      setRoutes(state.routes);
      setOtherRoutes(state.otherRoutes ?? []);
      setError(null);
    } catch (failure) {
      // A failed save rolls back to the last server-confirmed state so the
      // list never shows pools that were not written.
      if (lastSavedRef.current) setRoutes(lastSavedRef.current);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, []);

  const saveTuning = React.useCallback(async (next: ModelRouteTuning | null) => {
    setTuning(next);
    try {
      const state = await saveModelRouteTuning(next);
      setTuning(state.tuning ?? null);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  // An empty list removes the key, so the config carries no `model_route_schedules: []`.
  // Schedule saves go out one at a time, and only the newest edit's answer
  // lands: an older save finishing late must not replace a newer list on
  // screen, which the next edit would then write back.
  const scheduleSaveChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const scheduleSaveSeqRef = React.useRef(0);
  const saveSchedules = React.useCallback((next: ScheduleListValue) => {
    const seq = ++scheduleSaveSeqRef.current;
    setSchedules(next);
    const run = scheduleSaveChainRef.current.then(async () => {
      try {
        const state = await saveModelRouteSchedules(next.length > 0 ? next : null, settingsDirectory);
        lastSavedSchedulesRef.current = state.schedules ?? null;
        if (seq !== scheduleSaveSeqRef.current) return;
        setSchedules(state.schedules ?? null);
        setOtherSchedules(state.otherSchedules ?? []);
        setError(null);
      } catch (failure) {
        if (seq !== scheduleSaveSeqRef.current) return;
        setSchedules(lastSavedSchedulesRef.current);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    });
    scheduleSaveChainRef.current = run;
    return run;
  }, [settingsDirectory]);

  const applyPreset = (preset: PresetId) => {
    if (!routes) return;
    const targets = presetTargets(preset, providers);
    if (targets.length === 0) {
      setError(t('settings.pools.preset.empty'));
      return;
    }
    void persist({ ...routes, [PRESET_ROUTE_IDS[preset]]: { targets, autonomy: 'rules', selection: 'ordered' } });
    setExpandedId(PRESET_ROUTE_IDS[preset]);
  };

  // A pool needs at least one target to be saved, so a new pool stays a local draft until it gets one.
  const addPool = () => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!id || !routes || routes[id] || drafts[id]) return;
    setDrafts((current) => ({ ...current, [id]: { targets: [] } }));
    setNewId('');
    setExpandedId(id);
  };

  const withoutKey = (record: Record<string, ModelRoute>, id: string) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));

  const recentDecisions = React.useMemo(
    () => Object.values(decisions).sort((a, b) => b.at - a.at).slice(0, 8),
    [decisions],
  );

  // The health panel reads again whenever a pool's content changes.
  const routesKey = React.useMemo(() => JSON.stringify(routes), [routes]);

  const lowerTargetWeight = React.useCallback((poolID: string, targetRef: string) => {
    if (!routes) return;
    const route = routes[poolID];
    if (!route) return;
    const current = route.weights?.[targetRef] ?? 1;
    const next = Math.max(0.1, Math.round((current / 2) * 100) / 100);
    void persist({ ...routes, [poolID]: { ...route, weights: { ...route.weights, [targetRef]: next } } });
  }, [routes, persist]);

  return (
    <SettingsSection title={t('settings.pools.title')}>
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.description')}</p>
        {error ? <p className={SETTINGS_HELPER_CLASS}>{error}</p> : null}
        {!available ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.routing.unavailable')}</p>
        ) : routes === null ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.loading')}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button key={preset.id} size="sm" variant="outline" onClick={() => applyPreset(preset.id)} title={t(preset.infoKey)}>
                  {t(preset.titleKey)}
                </Button>
              ))}
            </div>
            <div className="divide-y divide-border/40 border-y border-border/40">
              {Object.entries({ ...routes, ...drafts }).map(([id, route]) => {
                const isDraft = id in drafts;
                return (
                  <PoolRow
                    key={id}
                    id={id}
                    route={route}
                    otherPoolIDs={Object.keys(routes).filter(
                      (other) => other !== id && !(route.targets ?? []).some((target) => routeReferenceID(target) === other),
                    )}
                    expanded={expandedId === id}
                    onToggle={() => setExpandedId((current) => (current === id ? null : id))}
                    onChange={(next) => {
                      if (isDraft && (next.targets ?? []).length === 0) {
                        setDrafts((current) => ({ ...current, [id]: next }));
                        return;
                      }
                      if (isDraft) setDrafts((current) => withoutKey(current, id));
                      void persist({ ...routes, [id]: next });
                    }}
                    onRemove={() => {
                      if (isDraft) {
                        setDrafts((current) => withoutKey(current, id));
                        return;
                      }
                      void persist(withoutKey(routes, id));
                    }}
                  />
                );
              })}
            </div>
            <SettingsFieldRow label={t('settings.pools.addLabel')} settingsItem="pools.add-pool">
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input
                  value={newId}
                  onChange={(event) => setNewId(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') addPool(); }}
                  placeholder={t('settings.pools.addPlaceholder')}
                  aria-label={t('settings.pools.addLabel')}
                  className="h-8 rounded-md px-3 min-w-0 flex-1"
                  maxLength={64}
                />
                <Button size="sm" variant="outline" onClick={addPool} disabled={newId.trim().length === 0 || saving}>
                  {t('settings.pools.add')}
                </Button>
              </div>
            </SettingsFieldRow>
            {otherRoutes.map((file) => (
              <div key={file.path} className="space-y-2">
                <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.otherFile', { path: file.path })}</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{JSON.stringify(file.routes, null, 2)}</pre>
              </div>
            ))}
            <div className="space-y-2">
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.tuning.title')}</p>
              <RouteTuningFields tuning={tuning} onSave={(next) => void saveTuning(next)} />
            </div>
            <RouteScheduleFields
              scope="global"
              schedules={schedules}
              onChange={(next) => void saveSchedules(next)}
              otherFiles={otherSchedules}
              settingsItem="routing.pools-schedules"
            />
            <PoolHealthSection onLowerWeight={lowerTargetWeight} reloadKey={routesKey} />
            <PoolTelemetry />
            {recentDecisions.length > 0 ? (
              <div className="space-y-1">
                <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.recentDecisions')}</p>
                {recentDecisions.map((decision) => (
                  <p key={`${decision.sessionId}-${decision.at}`} className="typography-meta text-muted-foreground truncate">
                    {decision.category ?? t('settings.pools.decisionFallback')}
                    {decision.providerID ? ` → ${decision.providerID}/${decision.modelID ?? ''}` : ''}
                    {` (${decision.reason})`}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
};
