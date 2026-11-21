import React from 'react';
import {
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatCompactNumber } from '@/lib/numberFormat';
import { opencodeClient } from '@/lib/opencode/client';
import { fetchOpenCodeCompatibility } from '@/lib/opencode/compatibility';
import type { Config } from '@/lib/opencode/model';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';

const OPENCODE_DEFAULT_KEEP_TOKENS = 15_000;
const BUFFER_PERCENT_STEPS = [5, 10, 20, 25, 30, 40, 50];
const KEEP_STEPS = [5_000, 10_000, 30_000, 50_000, 100_000];
const DEFAULT_OPTION = 'default';

type CompactionBuffer = string | number;

type CompactionValues = { auto: boolean; buffer: CompactionBuffer | null; keepTokens: number | null; background: boolean };

// OpenCode 2.3.1 moved background compaction from an experimental flag, off by default, to compaction.background, on by default.
const readsLegacyBackgroundFlag = (version: string | null | undefined): boolean => {
  const [major, minor, patch] = (version ?? '').split(/[-+]/, 1)[0].split('.').map(Number);
  if (![major, minor, patch].every(Number.isFinite)) return false;
  return major < 2 || (major === 2 && (minor < 3 || (minor === 3 && patch < 1)));
};

const legacyBackgroundFlag = (config: Config): boolean => {
  const flags: object = config.experimental ?? {};
  return 'background_compaction' in flags && flags.background_compaction === true;
};

const readCompaction = (config: Config, readsLegacyFlag: boolean): CompactionValues => ({
  auto: config.compaction?.auto !== false,
  buffer: config.compaction?.buffer ?? null,
  keepTokens: config.compaction?.keep?.tokens ?? null,
  background: readsLegacyFlag ? legacyBackgroundFlag(config) : config.compaction?.background !== false,
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

const BufferSelect: React.FC<{
  value: CompactionBuffer | null;
  disabled: boolean;
  onChange: (next: CompactionBuffer | null) => void;
}> = ({ value, disabled, onChange }) => {
  const { t } = useI18n();
  const steps: CompactionBuffer[] = BUFFER_PERCENT_STEPS.map((percent) => `${percent}%`);
  const options = value === null || steps.includes(value) ? steps : [...steps, value];
  const percentFormat = new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'percent', maximumFractionDigits: 1 });
  const label = (option: CompactionBuffer) => {
    const key = String(option);
    return key.endsWith('%')
      ? percentFormat.format(Number.parseFloat(key) / 100)
      : t('settings.openchamber.defaults.compaction.tokens', { count: formatCompactNumber(Number(key)) });
  };
  const defaultLabel = t('settings.openchamber.defaults.compaction.bufferDefault');
  return (
    <Select
      value={value === null ? DEFAULT_OPTION : String(value)}
      onValueChange={(next) => {
        const picked = next === DEFAULT_OPTION ? null : next.endsWith('%') ? next : Number(next);
        if (picked !== value) onChange(picked);
      }}
      disabled={disabled}
    >
      <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.openchamber.defaults.compaction.buffer')}>
        <SelectValue>{value === null ? defaultLabel : label(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_OPTION}>{defaultLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={String(option)}>{label(option)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const CompactionSettings: React.FC = () => {
  const { t } = useI18n();
  const [values, setValues] = React.useState<CompactionValues | null>(null);
  const saved = React.useRef<CompactionValues | null>(null);
  const writes = React.useRef(0);
  const latestFieldWrite = React.useRef<Partial<Record<keyof CompactionValues, number>>>({});

  React.useEffect(() => {
    let cancelled = false;
    const version = fetchOpenCodeCompatibility().then((compatibility) => compatibility.version, () => null);
    Promise.all([opencodeClient.getConfig(null), version]).then(
      ([config, openCodeVersion]) => {
        if (cancelled || writes.current > 0) return;
        saved.current = readCompaction(config, readsLegacyBackgroundFlag(openCodeVersion));
        setValues(saved.current);
      },
      (error) => console.warn('[compaction] failed to read config', error),
    );
    return () => {
      cancelled = true;
    };
  }, []);

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
          <BufferSelect
            value={values?.buffer ?? null}
            disabled={loading || autoOff}
            onChange={(buffer) => void save('buffer', buffer)}
          />
        </SettingsFieldRow>
        <SettingsCheckboxRow
          settingsItem="sessions.background-compaction"
          checked={values?.background ?? true}
          disabled={loading || autoOff}
          onChange={(background) => void save('background', background)}
          label={t('settings.openchamber.defaults.compaction.background')}
          info={t('settings.openchamber.defaults.compaction.backgroundInfo')}
        />
      </div>
    </SettingsSection>
  );
};
