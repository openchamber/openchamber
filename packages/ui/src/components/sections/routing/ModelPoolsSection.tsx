import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  fetchModelRoutes,
  fetchRouteStats,
  saveModelRouteSchedules,
  saveModelRouteTuning,
  saveModelRoutes,
  type HedgeAccuracy,
  type ModelRoute,
  type ModelRouteTuning,
  type PoolTimeoutSummary,
  type RouteErrorGroup,
  type RouteTargetStats,
} from '@/lib/routing/modelRoutesApi';
import { PoolHealthSection } from '@/components/sections/routing/PoolHealthSection';
import { PoolList } from '@/components/sections/routing/PoolList';
import { PoolPage } from '@/components/sections/routing/PoolPage';
import { RouteScheduleFields } from '@/components/sections/routing/RouteScheduleFields';
import type { ScheduleList, ScheduleListValue, StoredSchedules } from '@/lib/routing/scheduleSchema';
import { RouteTuningFields } from '@/components/sections/routing/RouteTuningFields';
import { PRESET_ROUTE_IDS, presetTargets, type PresetId } from '@/lib/routing/routePresets';
import { withPoolOrder, withoutAbsentWeights } from '@/lib/routing/poolAdvanced';
import { useConfigStore } from '@/stores/useConfigStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';

const PRESETS = [
  { id: 'cheap', titleKey: 'settings.pools.preset.cheap', infoKey: 'settings.pools.preset.cheapInfo' },
  { id: 'fast', titleKey: 'settings.pools.preset.fast', infoKey: 'settings.pools.preset.fastInfo' },
  { id: 'sturdy', titleKey: 'settings.pools.preset.sturdy', infoKey: 'settings.pools.preset.sturdyInfo' },
] as const;

/** A pool can be saved once it names at least one model, directly or by matching. */
const hasMembers = (route: ModelRoute) => (route.targets ?? []).length > 0 || Boolean(route.include?.length || route.contains?.length || route.match);

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

/**
 * Model pools: the list of pools in the order OpenCode reads them, and one
 * pool's own page when a row is opened. The list keeps what applies across
 * pools (presets, schedules, automatic review, health and telemetry).
 */
export const ModelPoolsSection: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const decisions = useRoutingStore((state) => state.decisions);
  const settingsDirectory = useSettingsDirectory();
  const [routes, setRoutes] = React.useState<Record<string, ModelRoute> | null>(null);
  const [timeouts, setTimeouts] = React.useState<Record<string, PoolTimeoutSummary>>({});
  const [available, setAvailable] = React.useState(true);
  const [drafts, setDrafts] = React.useState<Record<string, ModelRoute>>({});
  const [tuning, setTuning] = React.useState<ModelRouteTuning | null>(null);
  const [schedules, setSchedules] = React.useState<ScheduleList | null>(null);
  const [otherSchedules, setOtherSchedules] = React.useState<{ path: string; schedules: StoredSchedules }[]>([]);
  const [otherRoutes, setOtherRoutes] = React.useState<{ path: string; routes: Record<string, ModelRoute> }[]>([]);
  // The pool whose page is open. Local, so every visit to the tab starts at the list.
  const [openPoolId, setOpenPoolId] = React.useState<string | null>(null);
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
        setTimeouts(state.timeouts ?? {});
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
      setTimeouts(state.timeouts ?? {});
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
  };

  // A pool needs a model to be saved, so a new pool stays a local draft until it gets one.
  const addPool = () => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!id || !routes || routes[id] || drafts[id]) return;
    setDrafts((current) => ({ ...current, [id]: { targets: [] } }));
    setNewId('');
    setOpenPoolId(id);
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

  const openRoute = openPoolId === null || routes === null ? undefined : routes[openPoolId] ?? drafts[openPoolId];
  if (openPoolId !== null && routes !== null && openRoute) {
    const isDraft = openPoolId in drafts;
    return (
      <div id="routing-pool-page">
        {error ? <p className={`${SETTINGS_HELPER_CLASS} mb-4`}>{error}</p> : null}
        <PoolPage
          key={openPoolId}
          id={openPoolId}
          route={openRoute}
          timeoutSummary={timeouts[openPoolId]}
          otherPoolIDs={Object.keys(routes).filter((other) => other !== openPoolId)}
          onBack={() => setOpenPoolId(null)}
          onChange={(next) => {
            if (isDraft && !hasMembers(next)) {
              setDrafts((current) => ({ ...current, [openPoolId]: next }));
              return;
            }
            if (isDraft) setDrafts((current) => withoutKey(current, openPoolId));
            void persist({ ...routes, [openPoolId]: next });
          }}
          onRemove={() => {
            setOpenPoolId(null);
            if (isDraft) setDrafts((current) => withoutKey(current, openPoolId));
            else void persist(withoutKey(routes, openPoolId));
          }}
        />
      </div>
    );
  }

  // Pools saved before Settings wrote a first-output wait still run on
  // OpenCode's own 10-second default; any save writes the wait into them.
  const waitingOnOldDefault = routes !== null && Object.values(routes).some((route) => route.health?.firstTokenTimeoutMs === undefined);

  return (
    <SettingsSection title={t('settings.pools.title')} settingsItem="routing.pools-advanced">
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
            {waitingOnOldDefault ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--status-warning-background)] p-3">
                <p className="typography-meta min-w-0 flex-1 text-[var(--status-warning-text)]">{t('settings.pools.timeoutsPending')}</p>
                <Button size="sm" variant="outline" disabled={saving} onClick={() => void persist(routes)}>{t('settings.pools.timeoutsApply')}</Button>
              </div>
            ) : null}
            <PoolList
              routes={routes}
              drafts={drafts}
              onOpen={setOpenPoolId}
              onReorder={(orderedIds) => void persist(withPoolOrder(routes, orderedIds))}
            />
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
