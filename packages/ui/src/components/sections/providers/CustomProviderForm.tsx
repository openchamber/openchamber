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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  CUSTOM_PROVIDER_PROTOCOLS,
  createEmptyCustomProviderForm,
  createHeaderRow,
  createModelRow,
  validateCustomProvider,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type CustomProviderTranslator,
  type FieldErrors,
  type HeaderFieldErrors,
  type ModelFieldErrors,
  type DiscoveredModel,
  type DiscoverModelsErrorCode,
} from './custom-provider-form';

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

const DISCOVERY_ERROR_MESSAGES: Record<DiscoverModelsErrorCode, string> = {
  INVALID_URL: 'settings.providers.page.custom.models.discoveryError.unknown',
  SSRF_BLOCKED: 'settings.providers.page.custom.models.discoveryError.unknown',
  AUTH_FAILED: 'settings.providers.page.custom.models.discoveryError.authFailed',
  ACCESS_DENIED: 'settings.providers.page.custom.models.discoveryError.accessDenied',
  ENDPOINT_NOT_FOUND: 'settings.providers.page.custom.models.discoveryError.endpointNotFound',
  NETWORK_ERROR: 'settings.providers.page.custom.models.discoveryError.networkError',
  TIMEOUT: 'settings.providers.page.custom.models.discoveryError.timeout',
  INVALID_RESPONSE: 'settings.providers.page.custom.models.discoveryError.invalidResponse',
  PROVIDER_ERROR: 'settings.providers.page.custom.models.discoveryError.providerError',
  INTERNAL_ERROR: 'settings.providers.page.custom.models.discoveryError.unknown',
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

  // Model discovery state
  const [discoveredModels, setDiscoveredModels] = React.useState<DiscoveredModel[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = React.useState(false);
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(null);
  const [showModelSelector, setShowModelSelector] = React.useState(false);

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

  const setModel = (index: number, key: 'id' | 'name', value: string) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
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

  const handleFetchModels = async () => {
    const baseURL = form.baseURL.trim();
    if (!baseURL) {
      setDiscoveryError(t('settings.providers.page.custom.error.baseURL.required'));
      return;
    }

    setDiscoveryLoading(true);
    setDiscoveryError(null);

    try {
      const apiKey = form.apiKey.trim();
      const { env, key } = (() => {
        const trimmed = apiKey;
        if (!trimmed) return {};
        const envMatch = trimmed.match(/^\{env:([^}]+)\}$/);
        const env = envMatch?.[1]?.trim();
        if (env) return { env };
        return { key: trimmed };
      })();

      const headers: Record<string, string> = {};
      for (const header of form.headers) {
        const k = header.key.trim();
        const v = header.value.trim();
        if (k && v) headers[k] = v;
      }

      const response = await runtimeFetch('/api/provider/discover-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseURL, apiKey: key, env, headers }),
      });

      const data = await response.json();

      if (!response.ok) {
        const code = (data?.code as DiscoverModelsErrorCode) || 'INTERNAL_ERROR';
        let messageKey = DISCOVERY_ERROR_MESSAGES[code] || DISCOVERY_ERROR_MESSAGES.INTERNAL_ERROR;
        let message = t(messageKey);

        if (code === 'ENDPOINT_NOT_FOUND' && data?.error) {
          message = data.error;
        } else if (code === 'PROVIDER_ERROR' && data?.error) {
          message = t(messageKey, { message: data.error });
        }

        setDiscoveryError(message);
        return;
      }

      const models: DiscoveredModel[] = (data.models ?? []).map((m: { id: string; name: string }) => {
        const alreadyExists = form.models.some((existing) => existing.id.trim() === m.id);
        return {
          id: m.id,
          name: m.name,
          alreadyExists,
          selected: alreadyExists,
        };
      });

      setDiscoveredModels(models);
      setShowModelSelector(true);
    } catch {
      setDiscoveryError(t(DISCOVERY_ERROR_MESSAGES.INTERNAL_ERROR));
    } finally {
      setDiscoveryLoading(false);
    }
  };

  const handleModelSelectionChange = (modelId: string, checked: boolean) => {
    setDiscoveredModels((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, selected: checked } : m)),
    );
  };

  const handleSelectAll = () => {
    setDiscoveredModels((prev) => prev.map((m) => ({ ...m, selected: true })));
  };

  const handleClearAll = () => {
    setDiscoveredModels((prev) => prev.map((m) => ({ ...m, selected: false })));
  };

  const handleAddSelectedModels = () => {
    const selectedModels = discoveredModels.filter((m) => m.selected);
    const existingIds = new Set(form.models.map((m) => m.id.trim()).filter(Boolean));

    const newModels = selectedModels
      .filter((m) => !existingIds.has(m.id))
      .map((m) => createModelRow().row);

    if (newModels.length === 0 && selectedModels.every((m) => existingIds.has(m.id))) {
      setShowModelSelector(false);
      return;
    }

    setForm((prev) => {
      const newRows = selectedModels
        .filter((m) => !existingIds.has(m.id))
        .map((m) => ({
          row: createModelRow().row,
          id: m.id,
          name: m.name,
        }));

      return {
        ...prev,
        models: [...prev.models, ...newRows],
      };
    });

    setModelErrors((prev) => [...prev, ...new Array(newModels.length).fill({})]);
    setShowModelSelector(false);
  };

  const selectedCount = discoveredModels.filter((m) => m.selected).length;

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

  const canFetchModels = form.baseURL.trim().length > 0 && !discoveryLoading;

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
              setForm((prev) => ({ ...prev, protocol }));
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
          label={t('settings.providers.page.custom.field.baseURL.label')}
          info={t('settings.providers.page.custom.field.baseURL.info')}
        >
          <div className="flex items-center gap-2">
            <Input
              value={form.baseURL}
              onChange={(event) => setField('baseURL', event.target.value)}
              placeholder={t('settings.providers.page.custom.field.baseURL.placeholder')}
              className="h-8 rounded-md px-3 font-mono text-xs flex-1"
              aria-invalid={Boolean(err.baseURL)}
              aria-label={t('settings.providers.page.custom.field.baseURL.label')}
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal shrink-0"
              onClick={handleFetchModels}
              disabled={!canFetchModels || busy}
              aria-label={t('settings.providers.page.custom.field.baseURL.fetchModelsAria')}
            >
              {discoveryLoading
                ? t('settings.providers.page.custom.field.baseURL.fetchingModels')
                : t('settings.providers.page.custom.field.baseURL.fetchModels')}
            </Button>
          </div>
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
          <div key={model.row} className={`${SETTINGS_CONTROL_CLUSTER_CLASS} space-y-2`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.models.idLabel')}
                  </label>
                  <Input
                    value={model.id}
                    onChange={(event) => setModel(index, 'id', event.target.value)}
                    placeholder={t('settings.providers.page.custom.models.idPlaceholder')}
                    className="mt-1 h-8 rounded-md px-3 font-mono text-xs"
                    aria-label={t('settings.providers.page.custom.models.idLabel')}
                  />
                  {modelErrors[index]?.id ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.id}</p>
                  ) : null}
                </div>
                <div>
                  <label className={SETTINGS_FIELD_LABEL_CLASS}>
                    {t('settings.providers.page.custom.models.nameLabel')}
                  </label>
                  <Input
                    value={model.name}
                    onChange={(event) => setModel(index, 'name', event.target.value)}
                    placeholder={t('settings.providers.page.custom.models.namePlaceholder')}
                    className="mt-1 h-8 rounded-md px-3"
                    aria-label={t('settings.providers.page.custom.models.nameLabel')}
                  />
                  {modelErrors[index]?.name ? (
                    <p className="mt-1 typography-meta text-[var(--status-error)]">{modelErrors[index]?.name}</p>
                  ) : null}
                </div>
              </div>
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

      <Dialog open={showModelSelector} onOpenChange={setShowModelSelector}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{t('settings.providers.page.custom.models.selectorTitle')}</DialogTitle>
            <DialogDescription>{t('settings.providers.page.custom.models.selectorDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {discoveryError ? (
              <p className="typography-meta text-[var(--status-error)]" role="alert">
                {discoveryError}
              </p>
            ) : discoveredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground text-center py-8">
                {t('settings.providers.page.custom.models.noModelsFound')}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="typography-micro text-muted-foreground">
                    {t('settings.providers.page.custom.models.selectedCount', { selected: String(selectedCount), total: String(discoveredModels.length) })}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="!font-normal"
                      onClick={handleSelectAll}
                    >
                      {t('settings.providers.page.custom.models.selectAll')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="!font-normal"
                      onClick={handleClearAll}
                    >
                      {t('settings.providers.page.custom.models.clearAll')}
                    </Button>
                  </div>
                </div>
                <div className="max-h-[400px] overflow-y-auto space-y-1">
                  {discoveredModels.map((model) => (
                    <label
                      key={model.id}
                      className="flex items-center gap-3 p-2 rounded-md hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      <Checkbox
                        checked={model.selected}
                        onChange={(checked) => handleModelSelectionChange(model.id, checked)}
                        disabled={model.alreadyExists}
                        ariaLabel={`${model.name} (${model.id})`}
                      />
                      <div className="flex-1 min-w-0">
                        <span className="typography-body font-medium truncate block">{model.name}</span>
                        <span className="typography-micro text-muted-foreground font-mono truncate block">{model.id}</span>
                      </div>
                      {model.alreadyExists && (
                        <span className="typography-micro text-muted-foreground flex-shrink-0">
                          {t('settings.providers.page.custom.models.nameLabel')} (existing)
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowModelSelector(false)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              size="xs"
              className="!font-normal"
              onClick={handleAddSelectedModels}
              disabled={selectedCount === 0}
            >
              {t('settings.providers.page.custom.models.addSelected')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
};