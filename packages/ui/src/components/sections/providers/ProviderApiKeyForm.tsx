import React from 'react';
import type { FormValue, IntegrationKeyMethod } from '@opencode/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import {
  collectFieldAnswer,
  defaultFieldValues,
  fieldLabel,
  firstUnansweredField,
  isAnswerableField,
} from './provider-oauth';
import { ProviderFormFields } from './ProviderFormFields';

export interface IntegrationKeyRequest {
  integrationID: string;
  key: string;
  answer?: Record<string, FormValue>;
}

interface ProviderApiKeyFormProps {
  integrationId: string;
  /**
   * The integration's key method. Its `form` (an Azure resource name, a
   * Cloudflare account id) is answered alongside the key. Undefined for a
   * provider OpenCode has no integration for, which takes a bare key.
   */
  keyMethod: IntegrationKeyMethod | undefined;
  /** Stores the credential; injected so the form does not own the SDK call. */
  connectKey: (request: IntegrationKeyRequest) => Promise<void>;
  onSaved: () => void;
}

/**
 * The API key form for one integration. Mount with `key={integrationId}` so a
 * different provider starts from an empty form.
 */
export const ProviderApiKeyForm: React.FC<ProviderApiKeyFormProps> = ({
  integrationId,
  keyMethod,
  connectKey,
  onSaved,
}) => {
  const { t } = useI18n();
  const fields = React.useMemo(() => (keyMethod?.form ?? []).filter(isAnswerableField), [keyMethod]);
  const [apiKey, setApiKey] = React.useState('');
  // Only what the user typed; declared defaults fill the rest, so a catalog
  // refresh that changes the form never leaves a field without a value.
  const [editedValues, setEditedValues] = React.useState<Record<string, FormValue>>({});
  const fieldValues = React.useMemo(
    () => ({ ...defaultFieldValues(fields), ...editedValues }),
    [fields, editedValues],
  );
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    const key = apiKey.trim();
    if (!key) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return;
    }
    const unanswered = firstUnansweredField(fields, fieldValues);
    if (unanswered) {
      setFieldError(t('settings.providers.page.auth.oauth.promptRequired', { field: fieldLabel(unanswered) }));
      return;
    }
    setFieldError(null);

    const request: IntegrationKeyRequest = { integrationID: integrationId, key };
    const answer = collectFieldAnswer(fields, fieldValues);
    if (Object.keys(answer).length > 0) request.answer = answer;
    setSaving(true);
    try {
      await connectKey(request);
      toast.success(t('settings.providers.page.toast.apiKeySaved'));
      setApiKey('');
      onSaved();
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-1.5 space-y-3">
      <div>
        <label className="typography-ui-label text-foreground flex items-center gap-1.5">
          {t('settings.providers.page.auth.apiKeyLabel')}
          <SettingsInfoHint>{t('settings.providers.page.auth.apiKeyTooltip')}</SettingsInfoHint>
        </label>
        <div className="flex flex-col @xl:flex-row @xl:items-center gap-2 mt-1.5">
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
            className="flex-1 font-mono text-xs"
          />
          <Button
            size="xs"
            className="!font-normal shrink-0"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
          </Button>
        </div>
      </div>
      {fields.length > 0 ? (
        <ProviderFormFields
          fields={fields}
          values={fieldValues}
          onChange={(fieldKey, value) => setEditedValues((prev) => ({ ...prev, [fieldKey]: value }))}
        />
      ) : null}
      {fieldError ? (
        <p className="typography-meta text-[var(--status-error)]">{fieldError}</p>
      ) : null}
    </div>
  );
};
