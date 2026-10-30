import React from 'react';
import {
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { formatCompactNumber } from '@/lib/numberFormat';
import { opencodeClient } from '@/lib/opencode/client';
import type { Config } from '@/lib/opencode/model';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

/** OpenCode's `compaction.keep.tokens` when the config leaves it unset. */
const OPENCODE_DEFAULT_KEEP_TOKENS = 15_000;
const BUFFER_STEPS = [32_000, 64_000, 128_000, 256_000, 512_000];
const KEEP_STEPS = [5_000, 10_000, 30_000, 50_000, 100_000];
const DEFAULT_OPTION = 'default';

/** The compaction keys Settings edits; `null` leaves OpenCode's default. */
type CompactionValues = { auto: boolean; buffer: number | null; keepTokens: number | null; background: boolean };

const readCompaction = (config: Config): CompactionValues => ({
  auto: config.compaction?.auto !== false,
  buffer: config.compaction?.buffer ?? null,
  keepTokens: config.compaction?.keep?.tokens ?? null,
  background: config.experimental?.background_compaction === true,
});

const TokenCountSelect: React.FC<{
  value: number | null;
  steps: number[];
  defaultLabel: string;
  ariaLabel: string;
  disabled: boolean;
  onChange: (next: number | null) => void;
}> = ({ value, steps, defaultLabel, ariaLabel, disabled, onChange }) => {
  const { t } = useI18n();
  // A hand-written value outside the steps stays on the list, so it reads as chosen.
  const options = value === null || steps.includes(value) ? steps : [...steps, value].sort((a, b) => a - b);
  const label = (count: number) => t('settings.openchamber.defaults.compaction.tokens', { count: formatCompactNumber(count) });
  return (
    <Select
      value={value === null ? DEFAULT_OPTION : String(value)}
      onValueChange={(next) => {
        const picked = next === DEFAULT_OPTION ? null : Number(next);
        if (picked !== value) onChange(picked);
      }}
      disabled={disabled}
    >
      <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={ariaLabel}>
        <SelectValue>{value === null ? defaultLabel : label(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_OPTION}>{defaultLabel}</SelectItem>
        {options.map((count) => (
          <SelectItem key={count} value={String(count)}>{label(count)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * OpenCode's compaction settings in the global config: whether it compacts on
 * its own (`compaction.auto`), how early (`compaction.buffer`), how much
 * recent conversation stays beside the summary (`compaction.keep.tokens`), and
 * the experimental background summary (`experimental.background_compaction`).
 * Shows the values OpenCode reports and writes through
 * `PUT /api/config/compaction`. A project config can set any of them for
 * itself; the section says so and does not look for one.
 */
export const CompactionSettings: React.FC = () => {
  const { t } = useI18n();
  const [values, setValues] = React.useState<CompactionValues | null>(null);
  // What the config file holds as far as this page knows, and the newest write
  // per field, so a failed write puts back only the fields no later write changed.
  const saved = React.useRef<CompactionValues | null>(null);
  const writes = React.useRef(0);
  const latestFieldWrite = React.useRef<Partial<Record<keyof CompactionValues, number>>>({});

  React.useEffect(() => {
    let cancelled = false;
    opencodeClient.getConfig(null).then(
      (config) => {
        if (cancelled || writes.current > 0) return;
        saved.current = readCompaction(config);
        setValues(saved.current);
      },
      (error) => console.warn('[compaction] failed to read config', error),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Writes one field; the shown value changes at once and goes back if the write fails. */
  const save = async <K extends keyof CompactionValues>(field: K, value: CompactionValues[K]) => {
    const write = ++writes.current;
    latestFieldWrite.current[field] = write;
    setValues((current) => (current ? { ...current, [field]: value } : current));
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/config/compaction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (saved.current) saved.current = { ...saved.current, [field]: value };
      reportSettingsSaveState('saved');
      opencodeClient.clearConfigCache();
    } catch (error) {
      console.warn('[compaction] failed to save', error);
      reportSettingsSaveState('error');
      const restored = saved.current;
      if (restored && latestFieldWrite.current[field] === write) {
        setValues((current) => (current ? { ...current, [field]: restored[field] } : current));
      }
    }
  };

  const loading = values === null;
  // Buffer and background summaries only matter while OpenCode compacts on its own.
  const autoOff = values?.auto === false;

  return (
    <SettingsSection
      title={t('settings.openchamber.defaults.compaction.title')}
      description={t('settings.openchamber.defaults.compaction.projectNote')}
      contentClassName="space-y-1"
    >
      <SettingsFieldRow
        settingsItem="sessions.compaction-keep"
        label={t('settings.openchamber.defaults.compaction.keep')}
        info={t('settings.openchamber.defaults.compaction.keepInfo')}
      >
        <TokenCountSelect
          value={values?.keepTokens ?? null}
          steps={KEEP_STEPS}
          defaultLabel={t('settings.openchamber.defaults.compaction.keepDefault', {
            count: formatCompactNumber(OPENCODE_DEFAULT_KEEP_TOKENS),
          })}
          ariaLabel={t('settings.openchamber.defaults.compaction.keep')}
          disabled={loading}
          onChange={(keepTokens) => void save('keepTokens', keepTokens)}
        />
      </SettingsFieldRow>
      <SettingsCheckboxRow
        settingsItem="sessions.compaction-auto"
        checked={values?.auto ?? true}
        disabled={loading}
        onChange={(auto) => void save('auto', auto)}
        label={t('settings.openchamber.defaults.compaction.auto')}
        info={t('settings.openchamber.defaults.compaction.autoInfo')}
      />
      <div className="space-y-1 ps-6">
        <SettingsFieldRow
          settingsItem="sessions.compaction-buffer"
          label={t('settings.openchamber.defaults.compaction.buffer')}
          info={t('settings.openchamber.defaults.compaction.bufferInfo')}
        >
          <TokenCountSelect
            value={values?.buffer ?? null}
            steps={BUFFER_STEPS}
            defaultLabel={t('settings.openchamber.defaults.compaction.bufferDefault')}
            ariaLabel={t('settings.openchamber.defaults.compaction.buffer')}
            disabled={loading || autoOff}
            onChange={(buffer) => void save('buffer', buffer)}
          />
        </SettingsFieldRow>
        <SettingsCheckboxRow
          settingsItem="sessions.background-compaction"
          checked={values?.background ?? false}
          disabled={loading || autoOff}
          onChange={(background) => void save('background', background)}
          label={t('settings.openchamber.defaults.compaction.background')}
          info={t('settings.openchamber.defaults.compaction.backgroundInfo')}
        />
      </div>
    </SettingsSection>
  );
};
