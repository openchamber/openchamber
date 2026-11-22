import React from 'react';
import { SETTINGS_HELPER_CLASS, SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import { useI18n } from '@/lib/i18n';
import type { ModelRoute, PoolTimeoutSummary } from '@/lib/routing/modelRoutesApi';
import { pruneEmpty, setRouteField, withOptional } from '@/lib/routing/poolAdvanced';

type TimeoutChoice = 'default' | 'longest' | 'shortest' | 'own' | 'custom' | 'none';

const SECOND = 1000;
// The wait the server writes into a pool that names none
// (`DEFAULT_FIRST_OUTPUT_TIMEOUT_MS` in packages/web/server/lib/routing/pool-timeouts.js).
const DEFAULT_WAIT_MS = 30_000;

const choiceOf = (route: ModelRoute, nestsPools: boolean): TimeoutChoice => {
  const wait = route.health?.firstTokenTimeoutMs;
  if (nestsPools && route.nestedTimeout) return route.nestedTimeout;
  if (wait === false) return 'none';
  if (wait === undefined) return nestsPools ? 'longest' : 'default';
  return !nestsPools && wait === DEFAULT_WAIT_MS ? 'default' : 'custom';
};

/** The pool's wait for first output, its retries and its hedge: everything that decides when it moves on. */
export const PoolFailoverFields: React.FC<{
  route: ModelRoute;
  /** Whether the pool contains other pools, which makes longest and shortest meaningful. */
  nestsPools: boolean;
  /** What longest and shortest would pick, from the server; absent for a pool not saved yet. */
  summary?: PoolTimeoutSummary;
  onChange: (route: ModelRoute) => void;
}> = ({ route, nestsPools, summary, onChange }) => {
  const { t, locale } = useI18n();
  const formatWait = (value: number | false) => (value === false
    ? t('settings.pools.timeout.none')
    : new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(Math.round(value / SECOND)));
  const withPick = (label: string, value: number | false | undefined) => (value === undefined ? label : `${label} · ${formatWait(value)}`);
  // "Custom" stays chosen while its field is open, even when the number
  // typed equals the 30-second default the chips would otherwise show.
  const [customOpen, setCustomOpen] = React.useState(false);
  const choice = customOpen ? 'custom' : choiceOf(route, nestsPools);
  const wait = route.health?.firstTokenTimeoutMs;

  const withWait = (next: ModelRoute, value: number | false | undefined) =>
    setRouteField(next, 'health', pruneEmpty(withOptional(next.health, 'firstTokenTimeoutMs', value)));

  const pick = (next: TimeoutChoice) => {
    setCustomOpen(next === 'custom');
    const derived = next === 'longest' || next === 'shortest' || next === 'own';
    const base = setRouteField(route, 'nestedTimeout', derived ? next : undefined);
    // The server writes the value on save: for longest and shortest from the
    // pools this one contains, for own the 30-second default for its own models.
    if (derived) onChange(withWait(base, undefined));
    else if (next === 'none') onChange(withWait(base, false));
    else if (next === 'default') onChange(withWait(base, DEFAULT_WAIT_MS));
    else onChange(withWait(base, wait === undefined || wait === false ? DEFAULT_WAIT_MS : wait));
  };

  const options: Array<{ value: TimeoutChoice; label: string }> = [
    ...(nestsPools
      ? [
        { value: 'longest' as const, label: withPick(t('settings.pools.timeout.longest'), summary?.longest) },
        { value: 'shortest' as const, label: withPick(t('settings.pools.timeout.shortest'), summary?.shortest) },
        { value: 'own' as const, label: t('settings.pools.timeout.own') },
      ]
      : [{ value: 'default' as const, label: t('settings.pools.timeout.default') }]),
    { value: 'custom', label: t('settings.pools.timeout.custom') },
    { value: 'none', label: t('settings.pools.timeout.none') },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="typography-ui-label text-foreground">{t('settings.pools.timeout.label')}</span>
          <SettingsInfoHint>{t('settings.pools.timeout.info')}</SettingsInfoHint>
        </div>
        <SettingsChipGroup value={choice} options={options} onChange={pick} aria-label={t('settings.pools.timeout.label')} />
        {choice === 'custom' ? (
          <div className="max-w-[12rem]">
            <RangedNumberField
              label={t('settings.pools.timeout.seconds')}
              value={wait === undefined || wait === false ? undefined : wait / SECOND}
              min={1}
              max={3600}
              onCommit={(value) => onChange(withWait(route, value === undefined ? undefined : Math.round(value * SECOND)))}
            />
          </div>
        ) : null}
        <p className={SETTINGS_HELPER_CLASS}>
          {wait === undefined
            ? t('settings.pools.timeout.pending')
            : wait === false
              ? t('settings.pools.timeout.waitsNone')
              : t('settings.pools.timeout.waits', { seconds: Math.round(wait / SECOND) })}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <RangedNumberField
          label={t('settings.pools.advanced.attempts')}
          value={route.attempts}
          min={1}
          max={50}
          placeholder="2"
          onCommit={(value) => onChange(setRouteField(route, 'attempts', value))}
        />
        <RangedNumberField
          label={t('settings.pools.advanced.hedge')}
          value={route.hedgeAfterMs === undefined ? undefined : route.hedgeAfterMs / SECOND}
          min={1}
          max={3600}
          placeholder={t('settings.pools.advanced.off')}
          onCommit={(value) => onChange(setRouteField(route, 'hedgeAfterMs', value === undefined ? undefined : Math.round(value * SECOND)))}
        />
      </div>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.hedgeInfo')}</p>
    </div>
  );
};
