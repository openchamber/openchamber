import React from 'react';
import type { FormField, FormValue } from '@opencode/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { fieldLabel, visibleFields } from './provider-oauth';

interface ProviderFormFieldsProps {
  /** Fields an integration method declares, in declaration order. */
  fields: readonly FormField[];
  values: Record<string, FormValue>;
  onChange: (key: string, value: FormValue) => void;
}

/**
 * The inputs for an integration method's `form`, shared by OAuth sign-in and
 * API key methods. Labels, descriptions and placeholders come from what the
 * integration declares; only the fields whose conditions hold are shown.
 */
export const ProviderFormFields: React.FC<ProviderFormFieldsProps> = ({ fields, values, onChange }) => {
  const { t } = useI18n();

  const renderField = (field: FormField) => {
    if (field.type === 'external') {
      return (
        <div key={field.key} className="space-y-1.5">
          <label className="typography-ui-label text-foreground">{fieldLabel(field)}</label>
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => void openExternalUrl(field.url)}
          >
            {t('settings.providers.page.actions.open')}
          </Button>
        </div>
      );
    }

    const raw = values[field.key];
    const value = typeof raw === 'string' ? raw : '';
    const setValue = (next: FormValue) => onChange(field.key, next);

    const options = field.type === 'string' || field.type === 'multiselect' ? field.options ?? [] : [];

    return (
      <div key={field.key} className="space-y-1.5">
        <label className="typography-ui-label text-foreground">{fieldLabel(field)}</label>
        {field.description && (
          <p className="typography-meta text-muted-foreground">{field.description}</p>
        )}
        {options.length > 0 ? (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
              <SelectValue>
                {(current) => options.find((option) => option.value === current)?.label ?? null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.description ? `${option.label} · ${option.description}` : option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : field.type === 'boolean' ? (
          <input
            type="checkbox"
            checked={raw === true}
            onChange={(event) => setValue(event.target.checked)}
            aria-label={fieldLabel(field)}
          />
        ) : (
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={field.type === 'string' ? field.placeholder : undefined}
            aria-label={fieldLabel(field)}
            className="max-w-[24rem] text-xs"
          />
        )}
      </div>
    );
  };

  return <>{visibleFields(fields, values).map(renderField)}</>;
};
