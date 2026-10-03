import React from 'react';
import {
  SettingsCheckboxRow,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { cn } from '@/lib/utils';
import type { ModelFieldErrors, ModelRow } from './custom-provider-form';

const MODEL_CAPABILITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const;

export type ModelTextField = 'id' | 'name' | 'variants' | 'contextWindow' | 'maxOutputTokens';
export type ModelCapabilityList = 'inputCapabilities' | 'outputCapabilities';

type Props = {
  model: ModelRow;
  errors?: ModelFieldErrors;
  expanded: boolean;
  onToggle: () => void;
  onChange: (key: ModelTextField, value: string) => void;
  onToggleCapability: (target: ModelCapabilityList, capability: string) => void;
  onToolsChange: (tools: boolean) => void;
  onRemove?: () => void;
};

const positive = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * One model of a custom provider. Collapsed, it reads as a single line (name,
 * id, the limits and anything beyond plain text), so a provider with dozens
 * of imported models stays scannable; the editor opens on demand.
 */
export const CustomProviderModelRow: React.FC<Props> = ({
  model,
  errors,
  expanded,
  onToggle,
  onChange,
  onToggleCapability,
  onToolsChange,
  onRemove,
}) => {
  const { t } = useI18n();
  const editorId = React.useId();
  const id = model.id.trim();
  const name = model.name.trim();
  const title = name || id || t('settings.providers.page.custom.models.untitled');
  const context = positive(model.contextWindow);
  const output = positive(model.maxOutputTokens);
  const extraInputs = model.inputCapabilities.filter((capability) => capability !== 'text');
  const summary = [
    context ? t('settings.providers.page.custom.discovery.contextValue', { value: formatGoalTokens(context) }) : null,
    output ? t('settings.providers.page.custom.discovery.outputValue', { value: formatGoalTokens(output) }) : null,
    extraInputs.length > 0 ? extraInputs.join(', ') : null,
    model.tools ? null : t('settings.providers.page.custom.models.toolsOff'),
  ].filter(Boolean).join(' · ');

  const fieldError = (message?: string) => (
    message ? <p className="mt-1 typography-meta text-[var(--status-error)]">{message}</p> : null
  );

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <div className="flex items-center gap-1 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={editorId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <Icon
            name="arrow-right-s"
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn('truncate', SETTINGS_FIELD_LABEL_CLASS, !name && !id && 'text-muted-foreground')}>{title}</span>
              {name && id && name !== id ? (
                <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
              ) : null}
            </span>
            {summary ? <span className={cn('truncate', SETTINGS_HELPER_CLASS)}>{summary}</span> : null}
          </span>
        </button>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={SETTINGS_ICON_BUTTON_CLASS}
            onClick={onRemove}
            aria-label={t('settings.providers.page.custom.models.remove')}
          >
            <Icon name="delete-bin" className="size-4" />
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div id={editorId} className="space-y-3 pb-4 pl-7 pr-1 pt-1">
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            <div>
              <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.providers.page.custom.models.idLabel')}</label>
              <Input
                value={model.id}
                onChange={(event) => onChange('id', event.target.value)}
                placeholder={t('settings.providers.page.custom.models.idPlaceholder')}
                className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                aria-invalid={Boolean(errors?.id)}
                aria-label={t('settings.providers.page.custom.models.idLabel')}
              />
              {fieldError(errors?.id)}
            </div>
            <div>
              <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.providers.page.custom.models.nameLabel')}</label>
              <Input
                value={model.name}
                onChange={(event) => onChange('name', event.target.value)}
                placeholder={t('settings.providers.page.custom.models.namePlaceholder')}
                className="mt-1 h-8 rounded-md px-3"
                aria-invalid={Boolean(errors?.name)}
                aria-label={t('settings.providers.page.custom.models.nameLabel')}
              />
              {fieldError(errors?.name)}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            <div>
              <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.providers.page.custom.models.contextWindow')}</label>
              <Input
                inputMode="numeric"
                value={model.contextWindow}
                onChange={(event) => onChange('contextWindow', event.target.value)}
                placeholder="128000"
                className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                aria-invalid={Boolean(errors?.contextWindow)}
                aria-label={t('settings.providers.page.custom.models.contextWindow')}
              />
              {fieldError(errors?.contextWindow)}
            </div>
            <div>
              <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.providers.page.custom.models.maxOutputTokens')}</label>
              <Input
                inputMode="numeric"
                value={model.maxOutputTokens}
                onChange={(event) => onChange('maxOutputTokens', event.target.value)}
                placeholder="16384"
                className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                aria-invalid={Boolean(errors?.maxOutputTokens)}
                aria-label={t('settings.providers.page.custom.models.maxOutputTokens')}
              />
              {fieldError(errors?.maxOutputTokens)}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1">
              <label className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.providers.page.custom.models.variantsLabel')}</label>
              <SettingsInfoHint>{t('settings.providers.page.custom.models.variantsInfo')}</SettingsInfoHint>
            </div>
            <Input
              value={model.variants}
              onChange={(event) => onChange('variants', event.target.value)}
              placeholder={t('settings.providers.page.custom.models.variantsPlaceholder')}
              className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
              aria-label={t('settings.providers.page.custom.models.variantsLabel')}
            />
          </div>

          {(['inputCapabilities', 'outputCapabilities'] as const).map((target) => (
            <div key={target} className="space-y-1">
              <span className={SETTINGS_FIELD_LABEL_CLASS}>
                {target === 'inputCapabilities'
                  ? t('settings.providers.page.custom.models.inputCapabilities')
                  : t('settings.providers.page.custom.models.outputCapabilities')}
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {MODEL_CAPABILITIES.map((capability) => (
                  <SettingsCheckboxRow
                    key={capability}
                    checked={model[target].includes(capability)}
                    onChange={() => onToggleCapability(target, capability)}
                    label={capability}
                    ariaLabel={capability}
                  />
                ))}
              </div>
            </div>
          ))}

          <SettingsCheckboxRow
            checked={model.tools}
            onChange={onToolsChange}
            label={t('settings.providers.page.custom.models.tools')}
            ariaLabel={t('settings.providers.page.custom.models.tools')}
          />

          {model.metadataSource === 'models.dev' || model.metadataSource === 'provider-api' ? (
            <p className={SETTINGS_HELPER_CLASS}>
              {model.metadataSource === 'models.dev'
                ? t('settings.providers.page.custom.discovery.source.models.dev')
                : t('settings.providers.page.custom.discovery.source.provider-api')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
