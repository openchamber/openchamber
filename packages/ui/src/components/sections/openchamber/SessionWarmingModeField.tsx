import React from 'react';
import { SettingsChipGroup, SettingsFieldRow, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { Config } from '@/lib/opencode/model';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useSessionWarmingStore, WARMING_DURATION_STEPS, type SessionWarmingMode } from '@/stores/useSessionWarmingStore';

/** OpenCode's warming when it is not tuned: 30 minutes after the last turn. */
const OPENCODE_DEFAULT_MINUTES = 30;
const DURATION = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;
const UNIT_MINUTES = new Map([
  ...['ms', 'millis', 'millisecond', 'milliseconds'].map((unit) => [unit, 1 / 60_000] as const),
  ...['s', 'second', 'seconds'].map((unit) => [unit, 1 / 60] as const),
  ...['m', 'minute', 'minutes'].map((unit) => [unit, 1] as const),
  ...['h', 'hour', 'hours'].map((unit) => [unit, 60] as const),
]);

/**
 * OpenCode's warm duration in minutes, or null when warming is off or the
 * duration is not one OpenChamber can read. OpenCode answers durations like
 * `"1800000 millis"`; a hand-written `"30 minutes"` reads too.
 */
const readGlobalMinutes = (warming: Config['warming']): number | null => {
  if (!warming) return null;
  if (warming === true || !warming.duration) return OPENCODE_DEFAULT_MINUTES;
  const match = DURATION.exec(warming.duration.trim());
  const unit = match ? UNIT_MINUTES.get(match[2].toLowerCase()) : undefined;
  return match && unit ? Math.round(Number(match[1]) * unit) : null;
};

type GlobalWarming = { on: boolean; minutes: number | null };

/**
 * How idle sessions are kept warm, and for how long after a reply: OpenCode's
 * `warming` config for every session, or the OpenChamber server for the
 * sessions the user picks. One at a time; the server switches both in one
 * request. VS Code has no OpenChamber server and shows `SessionWarmingCheckbox`
 * instead.
 */
export const SessionWarmingModeField: React.FC = () => {
  const { t } = useI18n();
  const perSessionStatus = useSessionWarmingStore((state) => state.status);
  const perSession = useSessionWarmingStore((state) => state.enabled);
  const perSessionMinutes = useSessionWarmingStore((state) => state.minutes);
  const setMode = useSessionWarmingStore((state) => state.setMode);
  const setMinutes = useSessionWarmingStore((state) => state.setMinutes);
  const [global, setGlobal] = React.useState<GlobalWarming | null>(null);
  // The choices shown while a write is in flight, so the chips answer at once.
  const [pendingMode, setPendingMode] = React.useState<SessionWarmingMode | null>(null);
  const [pendingMinutes, setPendingMinutes] = React.useState<number | null>(null);
  const latestWrite = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    opencodeClient.getConfig(null).then(
      (config) => {
        if (!cancelled && latestWrite.current === 0) {
          setGlobal({ on: Boolean(config.warming), minutes: readGlobalMinutes(config.warming) });
        }
      },
      (error) => console.warn('[session-warming] failed to read config', error),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: SessionWarmingMode | null = pendingMode
    ?? (global === null || perSessionStatus === 'loading' ? null : global.on ? 'all' : perSession ? 'session' : 'off');
  const minutes = pendingMinutes ?? (mode === 'all' ? global?.minutes ?? null : perSessionMinutes);

  /** Runs one write with the shared save feedback; only the newest write settles the chips. */
  const save = React.useCallback(async (write: () => Promise<void>, settle: (latest: boolean) => void) => {
    const id = ++latestWrite.current;
    reportSettingsSaveState('saving');
    try {
      await write();
      reportSettingsSaveState('saved');
    } catch (error) {
      console.warn('[session-warming] failed to save', error);
      reportSettingsSaveState('error');
    } finally {
      settle(id === latestWrite.current);
    }
  }, []);

  const handleModeChange = (next: SessionWarmingMode) => {
    setPendingMode(next);
    void save(async () => {
      await setMode(next);
      opencodeClient.clearConfigCache();
      // Turning OpenCode's warming on keeps a duration already in its config.
      setGlobal((current) => ({ on: next === 'all', minutes: current?.minutes ?? OPENCODE_DEFAULT_MINUTES }));
    }, (latest) => {
      if (latest) setPendingMode(null);
    });
  };

  const handleMinutesChange = (next: number) => {
    if (mode !== 'all' && mode !== 'session') return;
    const scope = mode;
    setPendingMinutes(next);
    void save(async () => {
      await setMinutes(scope, next);
      if (scope === 'all') {
        opencodeClient.clearConfigCache();
        setGlobal({ on: true, minutes: next });
      }
    }, (latest) => {
      if (latest) setPendingMinutes(null);
    });
  };

  const step = WARMING_DURATION_STEPS.find((candidate) => candidate === minutes);
  // A server without per-session warming has no duration route either.
  const durationDisabled = mode === null || mode === 'off' || perSessionStatus === 'unavailable';

  return (
    <SettingsFieldRow
      settingsItem="sessions.warming"
      label={t('settings.openchamber.defaults.field.sessionWarming')}
      info={t('settings.openchamber.defaults.sessionWarming.info')}
    >
      <SettingsChipGroup<SessionWarmingMode>
        aria-label={t('settings.openchamber.defaults.sessionWarming.aria')}
        value={mode ?? 'off'}
        onChange={(next) => {
          if (mode !== null && next !== mode) handleModeChange(next);
        }}
        options={[
          { value: 'off', label: t('settings.openchamber.defaults.sessionWarming.off'), disabled: mode === null },
          { value: 'all', label: t('settings.openchamber.defaults.sessionWarming.all'), disabled: mode === null },
          {
            value: 'session',
            label: t('settings.openchamber.defaults.sessionWarming.session'),
            // A server without per-session warming still offers the other two.
            disabled: mode === null || perSessionStatus === 'unavailable',
          },
        ]}
      />
      {/* Always drawn, disabled while warming is off, so choosing a mode moves nothing. */}
      <Select
        // A hand-tuned OpenCode duration outside the steps shows no step.
        value={step === undefined ? undefined : String(step)}
        onValueChange={(next) => {
          const picked = Number(next);
          if (picked !== minutes) handleMinutesChange(picked);
        }}
        disabled={durationDisabled}
      >
        <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.openchamber.defaults.sessionWarming.durationAria')}>
          <SelectValue placeholder={t('settings.openchamber.defaults.sessionWarming.duration')}>
            {step === undefined ? undefined : t(`settings.openchamber.defaults.sessionWarming.duration.${step}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {WARMING_DURATION_STEPS.map((option) => (
            <SelectItem key={option} value={String(option)}>
              {t(`settings.openchamber.defaults.sessionWarming.duration.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};
