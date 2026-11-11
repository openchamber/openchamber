import * as React from 'react';

import { SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

const DEFAULT_VARIANT_VALUE = '__default__';

/**
 * The thinking level beside a model picker, shown only when that model has
 * levels. A saved level also keeps it on screen while the catalog loads, so
 * the choice never looks lost.
 */
export const ModelVariantSelect: React.FC<{
  variants: string[];
  value: string | undefined;
  onChange: (variant: string | undefined) => void;
  ariaLabel: string;
  /** The trigger's sizing where it sits in another kind of row. */
  triggerClassName?: string;
  /** Shown but closed, so a row keeps its layout while its option is off. */
  disabled?: boolean;
}> = ({ variants, value, onChange, ariaLabel, triggerClassName = SETTINGS_SELECT_ROW_TRIGGER_CLASS, disabled = false }) => {
  const { t } = useI18n();
  if (variants.length === 0 && !value) return null;
  const label = (variant: string) => (variant === DEFAULT_VARIANT_VALUE
    ? t('settings.openchamber.defaults.option.default')
    : variant.charAt(0).toUpperCase() + variant.slice(1));
  return (
    <Select
      value={value ?? DEFAULT_VARIANT_VALUE}
      onValueChange={(next) => onChange(next === DEFAULT_VARIANT_VALUE ? undefined : next || undefined)}
      disabled={disabled || variants.length === 0}
    >
      <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
        <SelectValue placeholder={t('settings.openchamber.defaults.field.thinkingPlaceholder')}>
          {label(value ?? DEFAULT_VARIANT_VALUE)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VARIANT_VALUE}>{label(DEFAULT_VARIANT_VALUE)}</SelectItem>
        {variants.map((variant) => (
          <SelectItem key={variant} value={variant}>{label(variant)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
