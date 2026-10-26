import React from 'react';
import {
  SettingsSection,
  SettingsStackedField,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { CUSTOM_PROVIDER_ICONS } from '@/lib/customProviderIcons';
import { cn } from '@/lib/utils';
import {
  CUSTOM_PROVIDER_PROTOCOLS,
  createEmptyCustomProviderForm,
  createHeaderRow,
  createModelRow,
  modelDiscoveryErrorSchema,
  modelDiscoveryResponseSchema,
  modelRowFromDiscovery,
  validateCustomProvider,
  type DiscoveredModel,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type CustomProviderTranslator,
  type FieldErrors,
  type HeaderFieldErrors,
  type ModelFieldErrors,
} from './custom-provider-form';
import { CustomProviderModelDiscovery } from './CustomProviderModelDiscovery';
import { CustomProviderModelRow, type ModelCapabilityList, type ModelTextField } from './CustomProviderModelRow';

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
  const [discovering, setDiscovering] = React.useState(false);
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = React.useState<DiscoveredModel[] | null>(null);
  // Rows open for editing. A provider can carry dozens of imported models, so
  // saved and imported rows start collapsed; a row added by hand opens.
  const [expandedRows, setExpandedRows] = React.useState<Set<string>>(() => (
    new Set(initialValues ? [] : form.models.map((model) => model.row))
  ));
  const seededEditProviderIdRef = React.useRef<string | null>(null);
  const logoProviderId = form.providerID.trim() || 'custom';
  const { hasLogo: providerHasLogo } = useProviderLogo(logoProviderId);

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
    setExpandedRows(new Set());
    setDiscoveredModels(null);
  }, [initialValues, isEdit]);

  const setField = (key: keyof Pick<CustomProviderFormState, 'providerID' | 'name' | 'baseURL' | 'apiKey'>, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErr((prev) => ({ ...prev, [key]: undefined }));
  };

  const setModel = (index: number, key: ModelTextField, value: string) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, rowIndex) => (
        rowIndex === index ? { ...row, [key]: value, metadataSource: 'manual' } : row
      )),
    }));
    setModelErrors((prev) => {
      const next = [...prev];
      next[index] = { ...(next[index] ?? {}), [key]: undefined };
      return next;
    });
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

  const discoverModels = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const headers = Object.fromEntries(form.headers
        .map((header) => [header.key.trim(), header.value.trim()] as const)
        .filter(([key, value]) => key && value));
      const response = await runtimeFetch('/api/provider/discover-models', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerID: isEdit ? form.providerID : undefined,
          baseURL: form.baseURL,
          apiKey: form.apiKey,
          headers,
          enrich: true,
          metadataProviderID: form.providerID,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = modelDiscoveryResponseSchema.safeParse(payload);
      if (!response.ok || !parsed.success) {
        throw new Error(modelDiscoveryErrorSchema.safeParse(payload).data?.error
          || t('settings.providers.page.custom.discovery.failed'));
      }
      setDiscoveredModels(parsed.data.models);
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : t('settings.providers.page.custom.discovery.failed'));
    } finally {
      setDiscovering(false);
    }
  };

  const addDiscoveredModels = (selected: DiscoveredModel[]) => {
    setForm((previous) => {
      const existing = new Set(previous.models.map((model) => model.id.trim()).filter(Boolean));
      const added = selected.filter((model) => !existing.has(model.id)).map(modelRowFromDiscovery);
      // The blank starter row of a new form gives way to the imported models.
      const kept = previous.models.filter((model) => model.id.trim() || model.name.trim());
      return { ...previous, models: [...kept, ...added] };
    });
    setModelErrors([]);
    setDiscoveredModels(null);
  };

  const toggleRow = (row: string) => setExpandedRows((previous) => {
    const next = new Set(previous);
    if (next.has(row)) next.delete(row);
    else next.add(row);
    return next;
  });

  const toggleCapability = (index: number, target: ModelCapabilityList, capability: string) => {
    setForm((previous) => ({
      ...previous,
      models: previous.models.map((model, rowIndex) => {
        if (rowIndex !== index) return model;
        const values = model[target];
        const next = values.includes(capability) ? values.filter((value) => value !== capability) : [...values, capability];
        return { ...model, [target]: next, capabilitiesKnown: true, metadataSource: 'manual' };
      }),
    }));
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
    // A collapsed row would hide its own error.
    const rowsWithErrors = form.models
      .filter((_, index) => Object.values(output.models[index] ?? {}).some(Boolean))
      .map((model) => model.row);
    if (rowsWithErrors.length > 0) {
      setExpandedRows((previous) => new Set([...previous, ...rowsWithErrors]));
    }
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
          label={t('settings.providers.page.custom.field.protocol.label')}
          info={t('settings.providers.page.custom.field.protocol.info')}
        >
          <Select
            value={form.protocol}
            onValueChange={(protocol) => {
              if (!(protocol in CUSTOM_PROVIDER_PROTOCOLS)) {
                return;
              }
              // Saved levels were spelled for the old protocol; rebuild them for the new one.
              setForm((prev) => ({
                ...prev,
                protocol,
                models: prev.models.map((row) => (row.savedVariants ? { ...row, savedVariants: {} } : row)),
              }));
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label={t('settings.providers.page.custom.field.protocol.label')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai-chat">{t('settings.providers.page.custom.field.protocol.openaiChat')}</SelectItem>
              <SelectItem value="openai-responses">{t('settings.providers.page.custom.field.protocol.openaiResponses')}</SelectItem>
              <SelectItem value="anthropic-messages">{t('settings.providers.page.custom.field.protocol.anthropicMessages')}</SelectItem>
            </SelectContent>
          </Select>
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
          label={t('settings.providers.page.custom.field.icon.label')}
          info={t('settings.providers.page.custom.field.icon.info')}
        >
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('settings.providers.page.custom.field.icon.label')}>
            {/* Default keeps the provider's own logo when its id has one. */}
            <Button
              type="button"
              variant={form.icon === null ? 'chip' : 'ghost'}
              size="icon"
              className={cn(SETTINGS_ICON_BUTTON_CLASS, form.icon === null && 'text-foreground')}
              aria-label={t('settings.providers.page.custom.field.icon.option.default')}
              title={t('settings.providers.page.custom.field.icon.option.default')}
              aria-pressed={form.icon === null}
              onClick={() => setForm((previous) => ({ ...previous, icon: null }))}
            >
              {providerHasLogo
                ? <ProviderLogo providerId={logoProviderId} className="size-4" ignoreCustomIcon />
                : <Icon name="checkbox-blank-circle" className="size-4 text-muted-foreground" />}
            </Button>
            {CUSTOM_PROVIDER_ICONS.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                variant={form.icon === entry.id ? 'chip' : 'ghost'}
                size="icon"
                className={cn(SETTINGS_ICON_BUTTON_CLASS, form.icon === entry.id && 'text-foreground')}
                aria-label={t(`settings.providers.page.custom.field.icon.option.${entry.id}`)}
                title={t(`settings.providers.page.custom.field.icon.option.${entry.id}`)}
                aria-pressed={form.icon === entry.id}
                onClick={() => setForm((previous) => ({ ...previous, icon: entry.id }))}
              >
                <Icon name={entry.icon} className="size-4" />
              </Button>
            ))}
          </div>
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
        <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} space-y-2`}>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => void discoverModels()}
              disabled={busy || discovering || !form.baseURL.trim()}
            >
              <Icon name="search" className="size-3.5" />
              {discovering
                ? t('settings.providers.page.custom.discovery.fetching')
                : t('settings.providers.page.custom.discovery.fetch')}
            </Button>
            <SettingsInfoHint>{t('settings.providers.page.custom.discovery.info')}</SettingsInfoHint>
          </div>
          {discoveryError ? <p className="typography-meta text-[var(--status-error)]" role="alert">{discoveryError}</p> : null}
          {discoveredModels ? (
            <CustomProviderModelDiscovery
              models={discoveredModels}
              existingIds={new Set(form.models.map((model) => model.id.trim()).filter(Boolean))}
              onAdd={addDiscoveredModels}
              onCancel={() => setDiscoveredModels(null)}
            />
          ) : null}
        </div>

        <div className={SETTINGS_CONTROL_CLUSTER_CLASS}>
          {form.models.map((model, index) => (
            <CustomProviderModelRow
              key={model.row}
              model={model}
              errors={modelErrors[index]}
              expanded={expandedRows.has(model.row)}
              onToggle={() => toggleRow(model.row)}
              onChange={(key, value) => setModel(index, key, value)}
              onToggleCapability={(target, capability) => toggleCapability(index, target, capability)}
              onToolsChange={(tools) => setForm((previous) => ({
                ...previous,
                models: previous.models.map((entry, rowIndex) => rowIndex === index ? { ...entry, tools, capabilitiesKnown: true, metadataSource: 'manual' } : entry),
              }))}
              onRemove={form.models.length > 1 ? () => {
                setForm((prev) => ({
                  ...prev,
                  models: prev.models.filter((_, rowIndex) => rowIndex !== index),
                }));
                setModelErrors((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
              } : undefined}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          onClick={() => {
            const row = createModelRow();
            setForm((prev) => ({ ...prev, models: [...prev.models, row] }));
            setModelErrors((prev) => [...prev, {}]);
            setExpandedRows((previous) => new Set([...previous, row.row]));
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
