import React from 'react';
import { SettingsFieldRow, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
import { useI18n } from '@/lib/i18n';

export function BotSelectField<T extends string>({ label, value, onChange, options, disabled }: {
  readonly label: string; readonly value: T; readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: React.ReactNode; readonly disabled?: boolean }[];
  readonly disabled?: boolean;
}) {
  return (
    <SettingsFieldRow label={label}>
      <Select<T> value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="max-w-full" aria-label={label}>
          <SelectValue>{() => options.find((option) => option.value === value)?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </SettingsFieldRow>
  );
}

/** Empty is inheritance/unlimited; zero is never converted to an empty value. */
export function BotLimitField({ label, value, onChange, min = 1 }: {
  readonly label: string; readonly value: number | null; readonly onChange: (value: number | null) => void; readonly min?: number;
}) {
  const { t } = useI18n();
  return (
    <SettingsStackedField label={label}>
      <NumberInput aria-label={label} min={min} value={value ?? undefined} onValueChange={onChange} onClear={() => onChange(null)} emptyLabel={t('bots.unlimited')} />
    </SettingsStackedField>
  );
}
