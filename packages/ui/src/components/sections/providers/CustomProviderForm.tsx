import React from 'react';
import {
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  CUSTOM_PROVIDER_PROTOCOLS,
  createEmptyCustomProviderForm,
  createHeaderRow,
  createModelRow,
  validateCustomProvider,
  type CustomProviderProtocol,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type CustomProviderTranslator,
  type CapabilitySetting,
  type FieldErrors,
  type HeaderFieldErrors,
  type ModelFieldErrors,
} from './custom-provider-form';

const CAPABILITY_SETTINGS: CapabilitySetting[] = ['default', 'supported', 'unsupported'];
const PROTOCOLS = Object.keys(CUSTOM_PROVIDER_PROTOCOLS) as CustomProviderProtocol[];
const PROTOCOL_LABEL_KEYS = {
  openaiChat: 'settings.providers.page.custom.protocol.openaiChat',
  openaiResponses: 'settings.providers.page.custom.protocol.openaiResponses',
  anthropicMessages: 'settings.providers.page.custom.protocol.anthropicMessages',
} as const;
const PROTOCOL_TRIGGER_LABELS: Record<CustomProviderProtocol, string> = {
  openaiChat: 'OpenAI Chat',
  openaiResponses: 'OpenAI Responses',
  anthropicMessages: 'Anthropic',
};
const CAPABILITY_LABEL_KEYS = {
  default: 'settings.providers.page.custom.models.capability.default',
  supported: 'settings.providers.page.custom.models.capability.supported',
  unsupported: 'settings.providers.page.custom.models.capability.unsupported',
} as const;

type CustomProviderFormProps = {
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  busy?: boolean;
  mode?: 'create' | 'edit';
  initialValues?: CustomProviderFormState;
  allowExistingAuth?: boolean;
  authFailureHint?: string | null;
  onSubmit: (plan: CustomProviderPersistPlan) => void | Promise<void>;
  onCancel?: () => void;
  onDisconnect?: () => void | Promise<void>;
};

export const CustomProviderForm: React.FC<CustomProviderFormProps> = ({
  existingProviderIDs,
  disabledProviders = [],
  busy = false,
  mode = 'create',
  initialValues,
  allowExistingAuth = false,
  authFailureHint = null,
  onSubmit,
  onCancel,
  onDisconnect,
}) => {
  const { t } = useI18n();
  const isEdit = mode === 'edit';
  const [form, setForm] = React.useState<CustomProviderFormState>(
    () => initialValues ?? createEmptyCustomProviderForm(),
  );
  const [err, setErr] = React.useState<FieldErrors>({});
  const [modelErrors, setModelErrors] = React.useState<ModelFieldErrors[]>([]);
  const [headerErrors, setHeaderErrors] = React.useState<HeaderFieldErrors[]>([]);
  const seededEditProviderIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!initialValues) {
      return;
    }
    // Edit mode: seed once per provider id so parent re-renders (new object
    // identity for the same snapshot) do not wipe in-progress edits.
    if (isEdit && seededEditProviderIdRef.current === initialValues.providerID) {
      return;
    }
    seededEditProviderIdRef.current = isEdit ? initialValues.providerID : null;
    setForm(initialValues);
    setErr({});
    setModelErrors([]);
    setHeaderErrors([]);
  }, [initialValues, isEdit]);

  const setField = (key: keyof Pick<CustomProviderFormState, 'providerID' | 'name' | 'baseURL' | 'apiKey'>, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErr((prev) => ({ ...prev, [key]: undefined }));
  };

  const setModel = <Key extends keyof Omit<CustomProviderFormState['models'][number], 'row'>>(
    index: number,
    key: Key,
    value: CustomProviderFormState['models'][number][Key],
  ) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
    }));
    if (key === 'id' || key === 'name' || key === 'contextLimit' || key === 'inputLimit' || key === 'outputLimit' || key === 'thinkingLevels') {
      setModelErrors((prev) => {
        const next = [...prev];
        next[index] = { ...(next[index] ?? {}), [key]: undefined };
        return next;
      });
    }
  };

  const setHeader = (index: number, key: 'key' | 'value', value: string) => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
    }));
    setHeaderErrors((prev) => {
      const next = [...prev];
      next[index] = { ...(next[index] ?? {}), [key]: undefined };
      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }

    const output = validateCustomProvider({
      form,
      t: ((key, vars) => t(key as Parameters<typeof t>[0], vars)) as CustomProviderTranslator,
      existingProviderIDs,
      disabledProviders,
      editingProviderID: isEdit ? form.providerID : undefined,
      allowExistingAuth: isEdit && allowExistingAuth,
    });
    setErr(output.err);
    setModelErrors(output.models);
    setHeaderErrors(output.headers);
    if (!output.result) {
      return;
    }
    await onSubmit(output.result);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      <SettingsSection
        title={isEdit ? t('settings.providers.page.custom.editTitle') : t('settings.providers.page.custom.title')}
        divider={false}
        settingsItem="providers.custom"
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.description')}</p>

        {authFailureHint ? (
          <p className="typography-meta text-[var(--status-warning)]" role="status">
            {authFailureHint}
          </p>
        ) : null}

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.providerID.label')}
          info={t('settings.providers.page.custom.field.providerID.info')}
        >
          <Input
            value={form.providerID}
            onChange={(event) => setField('providerID', event.target.value)}
            placeholder={t('settings.providers.page.custom.field.providerID.placeholder')}
            className="h-8 rounded-md px-3 font-mono text-xs"
            autoFocus={!isEdit}
            disabled={isEdit || busy}
            aria-invalid={Boolean(err.providerID)}
            aria-label={t('settings.providers.page.custom.field.providerID.label')}
          />
          {err.providerID ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.providerID}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.name.label')}
          info={t('settings.providers.page.custom.field.name.info')}
        >
          <Input
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            placeholder={t('settings.providers.page.custom.field.name.placeholder')}
            className="h-8 rounded-md px-3"
            aria-invalid={Boolean(err.name)}
            aria-label={t('settings.providers.page.custom.field.name.label')}
          />
          {err.name ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.name}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.protocol.label')}
          info={t('settings.providers.page.custom.protocol.info')}
        >
          <Select
            value={form.protocol}
            onValueChange={(value) => setForm((prev) => ({ ...prev, protocol: value as CustomProviderProtocol }))}
            disabled={busy}
          >
            <SelectTrigger
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_TRIGGER_CLASS}
              aria-label={t('settings.providers.page.custom.protocol.label')}
            >
              <SelectValue>{PROTOCOL_TRIGGER_LABELS[form.protocol]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PROTOCOLS.map((protocol) => (
                <SelectItem key={protocol} value={protocol}>
                  {t(PROTOCOL_LABEL_KEYS[protocol])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.baseURL.label')}
          info={t('settings.providers.page.custom.field.baseURL.info')}
        >
          <Input
            value={form.baseURL}
            onChange={(event) => setField('baseURL', event.target.value)}
            placeholder={t('settings.providers.page.custom.field.baseURL.placeholder')}
            className="h-8 rounded-md px-3 font-mono text-xs"
            aria-invalid={Boolean(err.baseURL)}
            aria-label={t('settings.providers.page.custom.field.baseURL.label')}
          />
          {err.baseURL ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.baseURL}</p> : null}
        </SettingsStackedField>

        <SettingsStackedField
          label={t('settings.providers.page.custom.field.apiKey.label')}
          info={
            isEdit && allowExistingAuth
              ? t('settings.providers.page.custom.field.apiKey.editInfo')
              : t('settings.providers.page.custom.field.apiKey.info')
          }
        >
          <Input
            type="password"
            value={form.apiKey}
            onChange={(event) => setField('apiKey', event.target.value)}
            placeholder={
              isEdit && allowExistingAuth
                ? t('settings.providers.page.custom.field.apiKey.editPlaceholder')
                : t('settings.providers.page.custom.field.apiKey.placeholder')
            }
            className="h-8 rounded-md px-3 font-mono text-xs"
            aria-invalid={Boolean(err.apiKey)}
            aria-label={t('settings.providers.page.custom.field.apiKey.label')}
          />
          {err.apiKey ? <p className="mt-1 typography-meta text-[var(--status-error)]">{err.apiKey}</p> : null}
        </SettingsStackedField>
      </SettingsSection>

      <SettingsSection
        title={t('settings.providers.page.custom.models.title')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        {form.models.map((model, index) => (
          <div key={model.row} className="space-y-4 border-b border-border/60 pb-6 last:border-b-0 last:pb-0">
            <div className="flex items-start gap-2">
              <SettingsTwoColumn className="min-w-0 flex-1 gap-4 @3xl:gap-6">
                <SettingsStackedField label={t('settings.providers.page.custom.models.idLabel')}>
                  <Input
                    value={model.id}
                    onChange={(event) => setModel(index, 'id', event.target.value)}
                    placeholder={t('settings.providers.page.custom.models.idPlaceholder')}
                    className="h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.models.idLabel')}
                  />
                  {modelErrors[index]?.id ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.id}</p>
                  ) : null}
                </SettingsStackedField>
                <SettingsStackedField label={t('settings.providers.page.custom.models.nameLabel')}>
                  <Input
                    value={model.name}
                    onChange={(event) => setModel(index, 'name', event.target.value)}
                    placeholder={t('settings.providers.page.custom.models.namePlaceholder')}
                    className="h-8 rounded-md px-3"
                    aria-label={t('settings.providers.page.custom.models.nameLabel')}
                  />
                  {modelErrors[index]?.name ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.name}</p>
                  ) : null}
                </SettingsStackedField>
              </SettingsTwoColumn>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SETTINGS_ICON_BUTTON_CLASS}
                disabled={form.models.length <= 1}
                onClick={() => {
                  if (form.models.length <= 1) return;
                  setForm((prev) => ({
                    ...prev,
                    models: prev.models.filter((_, rowIndex) => rowIndex !== index),
                  }));
                  setModelErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
                }}
                aria-label={t('settings.providers.page.custom.models.remove')}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>

            <SettingsTwoColumn className="gap-4 @3xl:gap-6">
              <SettingsStackedField
                label={t('settings.providers.page.custom.models.contextLimitLabel')}
                info={t('settings.providers.page.custom.models.contextLimitInfo')}
              >
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={model.contextLimit ?? ''}
                  onChange={(event) => setModel(index, 'contextLimit', event.target.value)}
                  placeholder={t('settings.providers.page.custom.models.contextLimitPlaceholder')}
                  className="h-8 rounded-md px-3 font-mono text-xs"
                  aria-invalid={Boolean(modelErrors[index]?.contextLimit)}
                  aria-label={t('settings.providers.page.custom.models.contextLimitLabel')}
                />
                {modelErrors[index]?.contextLimit ? (
                  <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.contextLimit}</p>
                ) : null}
              </SettingsStackedField>
              <SettingsStackedField
                label={t('settings.providers.page.custom.models.outputLimitLabel')}
                info={t('settings.providers.page.custom.models.outputLimitInfo')}
              >
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={model.outputLimit ?? ''}
                  onChange={(event) => setModel(index, 'outputLimit', event.target.value)}
                  placeholder={t('settings.providers.page.custom.models.outputLimitPlaceholder')}
                  className="h-8 rounded-md px-3 font-mono text-xs"
                  aria-invalid={Boolean(modelErrors[index]?.outputLimit)}
                  aria-label={t('settings.providers.page.custom.models.outputLimitLabel')}
                />
                {modelErrors[index]?.outputLimit ? (
                  <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.outputLimit}</p>
                ) : null}
              </SettingsStackedField>
            </SettingsTwoColumn>

            <SettingsTwoColumn className="gap-4 @3xl:gap-6">
              <SettingsStackedField
                label={t('settings.providers.page.custom.models.inputLimitLabel')}
                info={t('settings.providers.page.custom.models.inputLimitInfo')}
              >
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={model.inputLimit ?? ''}
                  onChange={(event) => setModel(index, 'inputLimit', event.target.value)}
                  placeholder={t('settings.providers.page.custom.models.inputLimitPlaceholder')}
                  className="h-8 rounded-md px-3 font-mono text-xs"
                  aria-invalid={Boolean(modelErrors[index]?.inputLimit)}
                  aria-label={t('settings.providers.page.custom.models.inputLimitLabel')}
                />
                {modelErrors[index]?.inputLimit ? (
                  <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.inputLimit}</p>
                ) : null}
              </SettingsStackedField>
              <SettingsStackedField
                label={t('settings.providers.page.custom.models.imageInputLabel')}
                info={t('settings.providers.page.custom.models.imageInputInfo')}
              >
                <CapabilitySelect
                  value={model.imageInput ?? 'default'}
                  onChange={(value) => setModel(index, 'imageInput', value)}
                  ariaLabel={t('settings.providers.page.custom.models.imageInputLabel')}
                  t={t}
                />
              </SettingsStackedField>
            </SettingsTwoColumn>

            <SettingsTwoColumn className="gap-4 @3xl:gap-6">
              <SettingsStackedField
                label={t('settings.providers.page.models.capability.reasoning')}
                info={t('settings.providers.page.custom.models.reasoningInfo')}
              >
                <CapabilitySelect
                  value={model.reasoning ?? 'default'}
                  onChange={(value) => setModel(index, 'reasoning', value)}
                  ariaLabel={t('settings.providers.page.models.capability.reasoning')}
                  t={t}
                />
              </SettingsStackedField>
              <SettingsStackedField
                label={t('settings.providers.page.models.capability.toolCalling')}
                info={t('settings.providers.page.custom.models.toolCallingInfo')}
              >
                <CapabilitySelect
                  value={model.toolCalling ?? 'default'}
                  onChange={(value) => setModel(index, 'toolCalling', value)}
                  ariaLabel={t('settings.providers.page.models.capability.toolCalling')}
                  t={t}
                />
              </SettingsStackedField>
            </SettingsTwoColumn>

            <SettingsStackedField
              label={t('settings.providers.page.models.thinkingLevels')}
              info={t('settings.providers.page.custom.models.thinkingLevelsInfo')}
            >
              <Input
                value={model.thinkingLevels ?? ''}
                onChange={(event) => setModel(index, 'thinkingLevels', event.target.value)}
                placeholder={t('settings.providers.page.custom.models.thinkingLevelsPlaceholder')}
                className="h-8 rounded-md px-3 font-mono text-xs"
                aria-invalid={Boolean(modelErrors[index]?.thinkingLevels)}
                aria-label={t('settings.providers.page.models.thinkingLevels')}
              />
              {modelErrors[index]?.thinkingLevels ? (
                <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.thinkingLevels}</p>
              ) : null}
            </SettingsStackedField>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            setForm((prev) => ({ ...prev, models: [...prev.models, createModelRow()] }));
            setModelErrors((prev) => [...prev, {}]);
          }}
        >
          {t('settings.providers.page.custom.models.add')}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t('settings.providers.page.custom.headers.title')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.headers.description')}</p>
        {form.headers.map((header, index) => (
          <div key={header.row} className={`${SETTINGS_CONTROL_CLUSTER_CLASS} space-y-2`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.headers.keyLabel')}
                  </label>
                  <Input
                    value={header.key}
                    onChange={(event) => setHeader(index, 'key', event.target.value)}
                    placeholder={t('settings.providers.page.custom.headers.keyPlaceholder')}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.headers.keyLabel')}
                  />
                  {headerErrors[index]?.key ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{headerErrors[index]?.key}</p>
                  ) : null}
                </div>
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.headers.valueLabel')}
                  </label>
                  <Input
                    value={header.value}
                    onChange={(event) => setHeader(index, 'value', event.target.value)}
                    placeholder={t('settings.providers.page.custom.headers.valuePlaceholder')}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.headers.valueLabel')}
                  />
                  {headerErrors[index]?.value ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{headerErrors[index]?.value}</p>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SETTINGS_ICON_BUTTON_CLASS}
                disabled={form.headers.length <= 1}
                onClick={() => {
                  if (form.headers.length <= 1) return;
                  setForm((prev) => ({
                    ...prev,
                    headers: prev.headers.filter((_, rowIndex) => rowIndex !== index),
                  }));
                  setHeaderErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
                }}
                aria-label={t('settings.providers.page.custom.headers.remove')}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            setForm((prev) => ({ ...prev, headers: [...prev.headers, createHeaderRow()] }));
            setHeaderErrors((prev) => [...prev, {}]);
          }}
        >
          {t('settings.providers.page.custom.headers.add')}
        </Button>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-2 py-4">
        {onCancel ? (
          <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={onCancel} disabled={busy}>
            {t('settings.providers.page.custom.actions.back')}
          </Button>
        ) : null}
        {onDisconnect ? (
          <Button
            type="button"
            variant="destructive"
            size="xs"
            className="!font-normal"
            onClick={() => void onDisconnect()}
            disabled={busy}
          >
            {t('settings.providers.page.actions.disconnect')}
          </Button>
        ) : null}
        <Button type="submit" size="xs" className="!font-normal" disabled={busy}>
          {busy
            ? t('settings.providers.page.actions.saving')
            : isEdit
              ? t('settings.providers.page.custom.actions.update')
              : t('settings.providers.page.custom.actions.save')}
        </Button>
      </div>
    </form>
  );
};

const CapabilitySelect: React.FC<{
  value: CapabilitySetting;
  onChange: (value: CapabilitySetting) => void;
  ariaLabel: string;
  t: ReturnType<typeof useI18n>['t'];
}> = ({ value, onChange, ariaLabel, t }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger
      size={SETTINGS_SELECT_SIZE}
      className={SETTINGS_SELECT_TRIGGER_CLASS}
      aria-label={ariaLabel}
    >
      <SelectValue>
        {t(CAPABILITY_LABEL_KEYS[value])}
      </SelectValue>
    </SelectTrigger>
    <SelectContent>
      {CAPABILITY_SETTINGS.map((setting) => (
        <SelectItem key={setting} value={setting}>
          {t(CAPABILITY_LABEL_KEYS[setting])}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
