import * as React from 'react';

import { SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

const DEFAULT_VARIANT_VALUE = '__default__';

export const ModelVariantSelect: React.FC<{
  variants: string[];
  value: string | undefined;
  onChange: (variant: string | undefined) => void;
  ariaLabel: string;
  triggerClassName?: string;
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
