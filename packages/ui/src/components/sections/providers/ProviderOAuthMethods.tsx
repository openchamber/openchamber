import React from 'react';
import type { FormField, FormValue, IntegrationOAuthMethod } from '@opencode/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { opencodeClient } from '@/lib/opencode/client';
import {
  collectFieldAnswer,
  defaultFieldValues,
  describeOAuthError,
  extractUserCode,
  fieldLabel,
  firstUnansweredField,
  isAnswerableField,
  shouldOpenAuthorizationUrl,
  visibleFields,
  type OAuthAttempt,
} from './provider-oauth';

interface ProviderOAuthMethodsProps {
  /** The integration that owns these methods; it shares the provider's id. */
  integrationId: string;
  methods: IntegrationOAuthMethod[];
  /** Called once a credential has been stored, so the caller can reload providers. */
  onConnected: () => void | Promise<void>;
  /**
   * Location the integration belongs to. Provider integrations are global;
   * an MCP server's OAuth integration exists only in the Location whose config
   * declares the server, so its requests must resolve that directory.
   */
  directory?: string | null;
  /** Layout only — the caller owns separation from whatever sits above. */
  className?: string;
}

type Flow =
  | { phase: 'idle' }
  | { phase: 'prompting'; methodID: string; fields: FormField[]; error: string | null }
  | { phase: 'connecting'; methodID: string }
  /** `auto`: the attempt is polled until the browser sign-in finishes. */
  | { phase: 'waiting'; methodID: string; attempt: OAuthAttempt }
  /** `code`: waiting for the user to paste a code out of the browser. */
  | { phase: 'awaitingCode'; methodID: string; attempt: OAuthAttempt; submitting: boolean }
  | { phase: 'failed'; methodID: string; message: string };

const IDLE: Flow = { phase: 'idle' };

/** How often an `auto` attempt is re-checked while the user signs in. */
const STATUS_POLL_INTERVAL_MS = 1500;

/**
 * OAuth sign-in for a provider's integration methods.
 *
 * The mode reported by `integration.oauth.connect` drives everything: `auto`
 * polls `integration.oauth.status` until the attempt completes, `code` collects
 * a pasted code and calls `integration.oauth.complete`. See `provider-oauth.ts`.
 *
 * Only one method can run at a time, and an abandoned attempt is cancelled
 * upstream on unmount so it cannot linger until it expires. Mount this with
 * `key={integrationId}` so switching providers starts from a clean flow.
 */
export const ProviderOAuthMethods: React.FC<ProviderOAuthMethodsProps> = ({
  integrationId,
  methods,
  onConnected,
  directory,
  className,
}) => {
  const { t } = useI18n();
  const sdk = React.useCallback(
    () => (directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()),
    [directory],
  );
  const [flow, setFlow] = React.useState<Flow>(IDLE);
  const [fieldValues, setFieldValues] = React.useState<Record<string, FormValue>>({});
  const [codeInput, setCodeInput] = React.useState('');
  /** Set while a poll loop is live; clearing it stops the loop at its next tick. */
  const activeAttemptRef = React.useRef<string | null>(null);

  const cancelAttempt = React.useCallback((attemptID: string) => {
    activeAttemptRef.current = null;
    void sdk()
      .integration.oauth.cancel({ integrationID: integrationId, attemptID })
      .catch(() => undefined);
  }, [integrationId, sdk]);

  React.useEffect(() => () => {
    const pending = activeAttemptRef.current;
    if (pending) cancelAttempt(pending);
  }, [cancelAttempt]);

  const activeMethodID = flow.phase === 'idle' ? null : flow.methodID;
  const busy = flow.phase === 'connecting'
    || flow.phase === 'waiting'
    || (flow.phase === 'awaitingCode' && flow.submitting);

  const copy = async (value: string, successKey: I18nKey, failureKey: I18nKey) => {
    const result = await copyTextToClipboard(value);
    if (result.ok) {
      toast.success(t(successKey));
      return;
    }
    console.error('Failed to copy OAuth value:', result.error);
    toast.error(t(failureKey));
  };

  const succeed = async () => {
    activeAttemptRef.current = null;
    setFlow(IDLE);
    toast.success(t('settings.providers.page.toast.oauthCompleted'));
    await onConnected();
  };

  const fail = (methodID: string, error: unknown, fallbackKey: I18nKey) => {
    activeAttemptRef.current = null;
    console.error('OAuth flow failed:', error);
    setFlow({ phase: 'failed', methodID, message: describeOAuthError(error, t, fallbackKey) });
  };

  /**
   * Polls an `auto` attempt to completion. Never throws: the user already has
   * control in the browser, so a failure here is a flow state, not an exception
   * to unwind. Stops as soon as the attempt is no longer the active one, which
   * is how cancel and unmount tear it down.
   */
  const pollAttempt = async (methodID: string, attemptID: string) => {
    const client = sdk();
    while (activeAttemptRef.current === attemptID) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
      if (activeAttemptRef.current !== attemptID) return;
      try {
        const { data: status } = await client.integration.oauth.status({ integrationID: integrationId, attemptID });
        if (activeAttemptRef.current !== attemptID) return;
        if (status.status === 'complete') {
          await succeed();
          return;
        }
        if (status.status === 'failed') {
          setFlow({ phase: 'failed', methodID, message: status.message });
          activeAttemptRef.current = null;
          return;
        }
      } catch (error) {
        if (activeAttemptRef.current !== attemptID) return;
        fail(methodID, error, 'settings.providers.page.toast.oauthCompleteFailed');
        return;
      }
    }
  };

  const runConnect = async (method: IntegrationOAuthMethod, answer: Record<string, FormValue>) => {
    setFlow({ phase: 'connecting', methodID: method.id });

    let attempt: OAuthAttempt;
    try {
      const { data } = await sdk().integration.oauth.connect({
        integrationID: integrationId,
        methodID: method.id,
        ...(Object.keys(answer).length > 0 ? { answer } : {}),
      });
      attempt = { attemptID: data.attemptID, mode: data.mode, url: data.url, instructions: data.instructions };
    } catch (error) {
      fail(method.id, error, 'settings.providers.page.toast.oauthStartFailed');
      return;
    }

    activeAttemptRef.current = attempt.attemptID;

    // Claude Code CLI owns its OAuth flow and opens the browser itself. Its
    // integration URL is informational only; opening it creates a misleading
    // docs tab alongside the real sign-in page.
    if (shouldOpenAuthorizationUrl(integrationId, attempt.url)) {
      void openExternalUrl(attempt.url);
    }

    if (attempt.mode === 'code') {
      setCodeInput('');
      setFlow({ phase: 'awaitingCode', methodID: method.id, attempt, submitting: false });
      return;
    }

    setFlow({ phase: 'waiting', methodID: method.id, attempt });
    await pollAttempt(method.id, attempt.attemptID);
  };

  const beginConnect = (method: IntegrationOAuthMethod) => {
    const fields = (method.form ?? []).filter(isAnswerableField);
    if (fields.length === 0) {
      void runConnect(method, {});
      return;
    }
    setFieldValues(defaultFieldValues(fields));
    setFlow({ phase: 'prompting', methodID: method.id, fields, error: null });
  };

  const submitFields = (method: IntegrationOAuthMethod) => {
    if (flow.phase !== 'prompting') {
      return;
    }
    const unanswered = firstUnansweredField(flow.fields, fieldValues);
    if (unanswered) {
      setFlow({
        ...flow,
        error: t('settings.providers.page.auth.oauth.promptRequired', { field: fieldLabel(unanswered) }),
      });
      return;
    }
    void runConnect(method, collectFieldAnswer(flow.fields, fieldValues));
  };

  const submitCode = async () => {
    if (flow.phase !== 'awaitingCode') {
      return;
    }
    const code = codeInput.trim();
    if (!code) {
      return;
    }
    const { methodID, attempt } = flow;
    setFlow({ ...flow, submitting: true });
    try {
      await sdk().integration.oauth.complete({
        integrationID: integrationId,
        attemptID: attempt.attemptID,
        code,
      });
      await succeed();
    } catch (error) {
      fail(methodID, error, 'settings.providers.page.toast.oauthCompleteFailed');
    }
  };

  /** Drops the attempt upstream so a half-finished sign-in cannot be resumed by accident. */
  const cancel = () => {
    if (flow.phase === 'waiting' || flow.phase === 'awaitingCode') {
      cancelAttempt(flow.attempt.attemptID);
    }
    setFlow(IDLE);
  };

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

    const raw = fieldValues[field.key];
    const value = typeof raw === 'string' ? raw : '';
    const setValue = (next: FormValue) =>
      setFieldValues((prev) => ({ ...prev, [field.key]: next }));

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
            className="max-w-[24rem] text-xs"
          />
        )}
      </div>
    );
  };

  const renderAttemptDetails = (attempt: OAuthAttempt) => {
    const userCode = extractUserCode(attempt.instructions);
    return (
      <>
        {attempt.instructions && (
          <p className="typography-meta text-[var(--status-info-text)] bg-[var(--status-info-background)] px-2 py-1.5 rounded">
            {attempt.instructions}
          </p>
        )}

        {userCode && (
          <div className="flex items-center gap-2">
            <Input
              value={userCode}
              readOnly
              aria-label={t('settings.providers.page.auth.oauth.deviceCodeLabel')}
              className="font-mono text-center tracking-widest"
            />
            <Button
              variant="outline"
              size="xs"
              className="!font-normal shrink-0"
              onClick={() => void copy(
                userCode,
                'settings.providers.page.toast.deviceCodeCopied',
                'settings.providers.page.toast.deviceCodeCopyFailed',
              )}
            >
              {t('settings.providers.page.actions.copyCode')}
            </Button>
          </div>
        )}

        {attempt.url && (
          <div className="flex items-center gap-2">
            <Input
              value={attempt.url}
              readOnly
              aria-label={t('settings.providers.page.auth.oauth.linkLabel')}
              className="text-xs text-muted-foreground"
            />
            <div className="flex gap-1 shrink-0">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => void openExternalUrl(attempt.url)}
              >
                {t('settings.providers.page.actions.open')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => void copy(
                  attempt.url,
                  'settings.providers.page.toast.oauthLinkCopied',
                  'settings.providers.page.toast.oauthLinkCopyFailed',
                )}
              >
                {t('settings.providers.page.actions.copy')}
              </Button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className={cn('space-y-4', className)}>
      {methods.map((method) => {
        const isActive = activeMethodID === method.id;

        return (
          <div key={method.id} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label text-foreground">{method.label}</div>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal shrink-0"
                onClick={() => beginConnect(method)}
                disabled={busy}
              >
                {t('settings.providers.page.actions.connect')}
              </Button>
            </div>

            {isActive && flow.phase === 'prompting' && (
              <div className="space-y-3">
                {visibleFields(flow.fields, fieldValues).map(renderField)}
                {flow.error && (
                  <p className="typography-meta text-[var(--status-error)]">{flow.error}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button size="xs" className="!font-normal" onClick={() => submitFields(method)}>
                    {t('settings.providers.page.actions.continue')}
                  </Button>
                  <Button variant="ghost" size="xs" className="!font-normal" onClick={cancel}>
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {isActive && flow.phase === 'connecting' && (
              <p className="typography-meta text-muted-foreground flex items-center gap-2">
                <Icon name="loader" className="h-3.5 w-3.5 animate-spin" />
                {t('settings.providers.page.auth.oauth.starting')}
              </p>
            )}

            {isActive && flow.phase === 'waiting' && (
              <div className="space-y-3">
                {renderAttemptDetails(flow.attempt)}
                <div className="flex items-center justify-between gap-2">
                  <p className="typography-meta text-muted-foreground flex items-center gap-2">
                    <Icon name="loader" className="h-3.5 w-3.5 animate-spin" />
                    {t('settings.providers.page.auth.oauth.waiting')}
                  </p>
                  <Button variant="ghost" size="xs" className="!font-normal shrink-0" onClick={cancel}>
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
                <p className="typography-meta text-muted-foreground">
                  {t('settings.providers.page.auth.oauth.waitingHint')}
                </p>
              </div>
            )}

            {isActive && flow.phase === 'awaitingCode' && (
              <div className="space-y-3">
                {renderAttemptDetails(flow.attempt)}
                <p className="typography-meta text-muted-foreground">
                  {t('settings.providers.page.auth.oauth.codeHint')}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={codeInput}
                    onChange={(event) => setCodeInput(event.target.value)}
                    placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                    className="font-mono text-xs"
                    disabled={flow.submitting}
                  />
                  <Button
                    size="xs"
                    className="!font-normal shrink-0"
                    onClick={() => void submitCode()}
                    disabled={flow.submitting || codeInput.trim().length === 0}
                  >
                    {flow.submitting
                      ? t('settings.providers.page.actions.saving')
                      : t('settings.providers.page.actions.complete')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="!font-normal shrink-0"
                    onClick={cancel}
                    disabled={flow.submitting}
                  >
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {isActive && flow.phase === 'failed' && (
              <div className="space-y-2">
                <p className="typography-meta text-[var(--status-error)]">{flow.message}</p>
                <Button
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={() => beginConnect(method)}
                >
                  {t('settings.providers.page.actions.tryAgain')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
