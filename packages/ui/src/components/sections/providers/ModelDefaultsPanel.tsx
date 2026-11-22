import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import {
  useLoadedOpenCodeModelSettings,
  useOpenCodeModelSettings,
  type OpenCodeModelSettingsPatch,
} from '@/lib/opencodeModelSettings';
import { useUIStore } from '@/stores/useUIStore';

// The select value for "no effort": OpenCode never names a variant this way.
const PROVIDER_DEFAULT = '__provider__';

const levelLabel = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);

const EffortSelect: React.FC<{
  value: string | undefined;
  variants: readonly string[];
  label: string;
  disabled?: boolean;
  onChange: (variant: string | undefined) => void;
}> = ({ value, variants, label, disabled, onChange }) => {
  const { t } = useI18n();
  // A saved effort the catalog no longer lists stays visible, so it can be seen and cleared.
  const choices = value !== undefined && !variants.includes(value) ? [...variants, value] : variants;
  return (
    <Select value={value ?? PROVIDER_DEFAULT} disabled={disabled} onValueChange={(next) => onChange(next === PROVIDER_DEFAULT ? undefined : next)}>
      <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
        <SelectValue>{value ? levelLabel(value) : t('settings.modelDefaults.providerDefault')}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PROVIDER_DEFAULT}>{t('settings.modelDefaults.providerDefault')}</SelectItem>
        {choices.map((variant) => <SelectItem key={variant} value={variant}>{levelLabel(variant)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
};

const LockBox: React.FC<{ checked: boolean; disabled: boolean; label: string; onChange: (locked: boolean) => void }> = ({
  checked,
  disabled,
  label,
  onChange,
}) => {
  const { t } = useI18n();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Checkbox checked={checked} disabled={disabled} onChange={onChange} ariaLabel={label} />
      <span className="typography-meta text-muted-foreground">{t('settings.modelDefaults.lock')}</span>
    </span>
  );
};

/**
 * One model's own defaults, in two clearly separate places: OpenChamber's
 * (the effort this app sends when the model is picked directly, optionally
 * locked) and OpenCode's config (hidden, default effort and lock, which every
 * OpenCode client applies). Used on a provider's model list and in a pool
 * member's options, so both show the same settings.
 */
export const ModelDefaultsPanel: React.FC<{
  providerID: string;
  modelID: string;
  /** The model's variants (effort levels) as the catalog lists them. */
  variants: readonly string[];
  /** The model as the user reads it, for accessible labels. */
  name: string;
}> = ({ providerID, modelID, variants, name }) => {
  const { t } = useI18n();
  const key = `${providerID}/${modelID}`;
  const appDefault = useUIStore((state) => state.modelDefaultVariants[key]);
  const appLocked = useUIStore((state) => state.modelDefaultVariantLocks.includes(key));
  const setModelDefaultVariant = useUIStore((state) => state.setModelDefaultVariant);
  const setModelDefaultVariantLocked = useUIStore((state) => state.setModelDefaultVariantLocked);

  const status = useLoadedOpenCodeModelSettings();
  const opencode = useOpenCodeModelSettings((state) => state.models[key]);
  const path = useOpenCodeModelSettings((state) => state.path);
  const writable = useOpenCodeModelSettings((state) => state.writable);
  const save = useOpenCodeModelSettings((state) => state.save);
  const [error, setError] = React.useState<string | null>(null);

  const change = (settings: OpenCodeModelSettingsPatch) => {
    setError(null);
    save(providerID, modelID, settings).catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="typography-meta text-muted-foreground">{t('settings.modelDefaults.direct')}</span>
        <SettingsInfoHint>{t('settings.modelDefaults.directInfo')}</SettingsInfoHint>
        <EffortSelect
          value={appDefault}
          variants={variants}
          label={t('settings.modelDefaults.directAria', { name })}
          onChange={(variant) => setModelDefaultVariant(providerID, modelID, variant)}
        />
        <LockBox
          checked={appLocked}
          disabled={!appDefault}
          label={t('settings.modelDefaults.lockAria', { name })}
          onChange={(locked) => setModelDefaultVariantLocked(providerID, modelID, locked)}
        />
      </div>
      {status === 'ready' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <span className="typography-meta font-medium text-foreground">{t('settings.modelDefaults.opencodeTitle')}</span>
            <SettingsInfoHint>{t('settings.modelDefaults.opencodeInfo', { path: path ?? '' })}</SettingsInfoHint>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-1.5">
              <Checkbox
                checked={opencode?.hidden === true}
                disabled={!writable}
                onChange={(hidden) => change({ hidden: hidden ? true : null })}
                ariaLabel={t('settings.modelDefaults.opencodeHiddenAria', { name })}
              />
              <span className="typography-meta text-muted-foreground">{t('settings.modelDefaults.opencodeHidden')}</span>
            </span>
            <EffortSelect
              value={opencode?.defaultVariant}
              variants={variants}
              disabled={!writable}
              label={t('settings.modelDefaults.opencodeEffortAria', { name })}
              onChange={(variant) => change(variant ? { defaultVariant: variant } : { defaultVariant: null, lockVariant: null })}
            />
            <LockBox
              checked={opencode?.lockVariant === true}
              disabled={!writable || !opencode?.defaultVariant}
              label={t('settings.modelDefaults.opencodeLockAria', { name })}
              onChange={(locked) => change({ lockVariant: locked ? true : null })}
            />
          </div>
          {writable ? null : <p className={SETTINGS_HELPER_CLASS}>{t('settings.modelDefaults.opencodeReadOnly')}</p>}
          {error ? <p className="typography-meta text-[var(--status-error-text)]">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
};
