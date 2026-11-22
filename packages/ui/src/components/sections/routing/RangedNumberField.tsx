import React from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { parseFormNumber } from '@/lib/routing/poolAdvanced';
import { cn } from '@/lib/utils';

const isValidFormNumber = (value: number | undefined, min: number, max: number, step: number | 'any') =>
  value === undefined || (value >= min && value <= max && (step !== 1 || Number.isInteger(value)));

/** A form number that commits on blur or Enter and refuses values outside its range. */
export const RangedNumberField: React.FC<{
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number | 'any';
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: number | undefined) => void;
}> = ({ label, value, min, max, step = 1, placeholder, disabled = false, onCommit }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(value === undefined ? '' : String(value));
  const valid = isValidFormNumber(parseFormNumber(draft), min, max, step);

  React.useEffect(() => {
    setDraft(value === undefined ? '' : String(value));
  }, [value]);

  const commit = (text: string) => {
    setDraft(text);
    const next = parseFormNumber(text);
    if (!isValidFormNumber(next, min, max, step) || next === value) return;
    onCommit(next);
  };

  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="typography-meta text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
        }}
        className={cn('h-8 w-full min-w-0 rounded-md px-2', !valid && 'border-destructive')}
      />
      {valid ? null : (
        <span className="typography-meta text-destructive">{t('settings.pools.advanced.range', { min, max })}</span>
      )}
    </label>
  );
};
