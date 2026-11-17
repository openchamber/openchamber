import React from 'react';
import type { FormField, FormValue } from '@opencode/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Spinner } from '@/components/ui/spinner';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { opencodeClient } from '@/lib/opencode/client';
import { getIntegrationClient } from '@/lib/opencode/integration-catalog';
import {
  collectFieldAnswer,
  defaultFieldValues,
  describeOAuthError,
  extractUserCode,
  fieldLabel,
  firstUnansweredField,
  isAnswerableField,
  shouldOpenAuthorizationUrl,
  type OAuthAttempt,
} from './provider-oauth';
import { ProviderFormFields } from './ProviderFormFields';
import type { SignInMethod } from './providerAuth';

interface ProviderOAuthMethodsProps {
  integrationId: string;
  methods: SignInMethod[];
  onConnected: () => void | Promise<void>;
  directory?: string | null;
  className?: string;
  autoStart?: boolean;
  showMethodLabels?: boolean;
  connectLabel?: string;
  showStartButton?: boolean;
  onActiveChange?: (active: boolean) => void;
}

type Flow =
  | { phase: 'idle' }
  | { phase: 'prompting'; methodID: string; fields: FormField[]; error: string | null }
  | { phase: 'connecting'; methodID: string }
  | { phase: 'waiting'; methodID: string; attempt: OAuthAttempt }
  | { phase: 'awaitingCode'; methodID: string; attempt: OAuthAttempt; submitting: boolean }
  | { phase: 'failed'; methodID: string; message: string };

const IDLE: Flow = { phase: 'idle' };

const STATUS_POLL_INTERVAL_MS = 1500;

export const ProviderOAuthMethods: React.FC<ProviderOAuthMethodsProps> = ({
  integrationId,
  methods,
  onConnected,
  directory,
  className,
  autoStart = false,
  showMethodLabels = true,
  connectLabel,
  showStartButton = true,
  onActiveChange,
}) => {
  const { t } = useI18n();
  const client = React.useMemo(
    () => (directory ? opencodeClient.getScopedSdkClient(directory) : getIntegrationClient()),
    [directory],
  );
  const sdk = React.useCallback(() => client, [client]);
  const [flow, setFlow] = React.useState<Flow>(IDLE);
  const [fieldValues, setFieldValues] = React.useState<Record<string, FormValue>>({});
  const [codeInput, setCodeInput] = React.useState('');
  const [redirectInput, setRedirectInput] = React.useState('');
  const [redirectSubmit, setRedirectSubmit] = React.useState<{ submitting: boolean; error: string | null }>({
    submitting: false,
    error: null,
  });
  const activeAttemptRef = React.useRef<string | null>(null);

  const cancelAttempt = React.useCallback((attemptID: string) => {
    activeAttemptRef.current = null;
    void sdk()
      .integration.oauth.cancel({ integrationID: integrationId, attemptID })
      .catch(() => undefined);
  }, [integrationId, sdk]);

  const unmountedRef = React.useRef(false);
  React.useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const pending = activeAttemptRef.current;
      if (pending) cancelAttempt(pending);
    };
  }, [cancelAttempt]);

  const activeMethodID = flow.phase === 'idle' ? null : flow.methodID;

  const signInActive = flow.phase !== 'idle' && flow.phase !== 'failed';
  React.useEffect(() => {
    if (!signInActive || !onActiveChange) return undefined;
    onActiveChange(true);
    return () => onActiveChange(false);
  }, [signInActive, onActiveChange]);
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

  const succeed = async (successKey: I18nKey = 'settings.providers.page.toast.oauthCompleted') => {
    activeAttemptRef.current = null;
    setFlow(IDLE);
    toast.success(t(successKey));
    await onConnected();
  };

  const fail = (methodID: string, error: unknown, fallbackKey: I18nKey) => {
    activeAttemptRef.current = null;
    console.error('OAuth flow failed:', error);
    setFlow({ phase: 'failed', methodID, message: describeOAuthError(error, t, fallbackKey) });
  };

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

  const runExternalConnect = async (methodID: string, answer: Record<string, FormValue>) => {
    setFlow({ phase: 'connecting', methodID });
    try {
      await sdk().integration.connect.external({
        integrationID: integrationId,
        methodID,
        answer: Object.keys(answer).length > 0 ? answer : undefined,
      });
    } catch (error) {
      fail(methodID, error, 'settings.providers.page.toast.externalConnectFailed');
      return;
    }
    await succeed('settings.providers.page.toast.externalConnected');
  };

  const runConnect = async (method: SignInMethod, answer: Record<string, FormValue>) => {
    if (method.type === 'external') {
      await runExternalConnect(method.id, answer);
      return;
    }
    setFlow({ phase: 'connecting', methodID: method.id });

    let attempt: OAuthAttempt;
    try {
      const { data } = await sdk().integration.oauth.connect({
        integrationID: integrationId,
        methodID: method.id,
        ...(Object.keys(answer).length > 0 ? { answer } : {}),
      });
      attempt = {
        attemptID: data.attemptID,
        mode: data.mode,
        url: data.url,
        instructions: data.instructions,
        paste: data.paste === true,
      };
    } catch (error) {
      fail(method.id, error, 'settings.providers.page.toast.oauthStartFailed');
      return;
    }

    if (unmountedRef.current) {
      cancelAttempt(attempt.attemptID);
      return;
    }
    activeAttemptRef.current = attempt.attemptID;

    if (shouldOpenAuthorizationUrl(integrationId, attempt.url)) {
      void openExternalUrl(attempt.url);
    }

    if (attempt.mode === 'code') {
      setCodeInput('');
      setFlow({ phase: 'awaitingCode', methodID: method.id, attempt, submitting: false });
      return;
    }

    setRedirectInput('');
    setRedirectSubmit({ submitting: false, error: null });
    setFlow({ phase: 'waiting', methodID: method.id, attempt });
    await pollAttempt(method.id, attempt.attemptID);
  };

  const beginConnect = (method: SignInMethod) => {
    const fields = (method.form ?? []).filter(isAnswerableField);
    if (fields.length === 0) {
      void runConnect(method, {});
      return;
    }
    setFieldValues(defaultFieldValues(fields));
    setFlow({ phase: 'prompting', methodID: method.id, fields, error: null });
  };

  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (!autoStart || autoStartedRef.current || methods.length !== 1) return;
    autoStartedRef.current = true;
    beginConnect(methods[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, methods]);

  const submitFields = (method: SignInMethod) => {
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

  const submitRedirect = async () => {
    if (flow.phase !== 'waiting') return;
    const address = redirectInput.trim();
    if (!address) return;
    const { attemptID } = flow.attempt;
    setRedirectSubmit({ submitting: true, error: null });
    try {
      await sdk().integration.oauth.complete({ integrationID: integrationId, attemptID, code: address });
    } catch (error) {
      if (activeAttemptRef.current !== attemptID) return;
      setRedirectSubmit({
        submitting: false,
        error: describeOAuthError(error, t, 'settings.providers.page.toast.oauthCompleteFailed'),
      });
    }
  };

  const cancel = () => {
    if (flow.phase === 'waiting' || flow.phase === 'awaitingCode') {
      cancelAttempt(flow.attempt.attemptID);
    }
    setFlow(IDLE);
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
            {showStartButton ? (
              <div className="flex items-center justify-between gap-2">
                {showMethodLabels ? <div className="typography-ui-label text-foreground">{method.label}</div> : null}
                <Button
                  variant="outline"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={() => beginConnect(method)}
                  disabled={busy}
                >
                  {connectLabel ?? t('settings.providers.page.actions.connect')}
                </Button>
              </div>
            ) : null}

            {isActive && flow.phase === 'prompting' && (
              <div className="space-y-3">
                <ProviderFormFields
                  fields={flow.fields}
                  values={fieldValues}
                  onChange={(key, value) => setFieldValues((prev) => ({ ...prev, [key]: value }))}
                />
                {flow.error && (
                  <p dir="auto" className="typography-meta text-[var(--status-error)]">{flow.error}</p>
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
                <Spinner className="h-3.5 w-3.5" />
                {method.type === 'external'
                  ? t('settings.providers.page.auth.external.connecting')
                  : t('settings.providers.page.auth.oauth.starting')}
              </p>
            )}

            {isActive && flow.phase === 'waiting' && (
              <div className="space-y-3">
                {renderAttemptDetails(flow.attempt)}
                <div className="flex items-center justify-between gap-2">
                  <p className="typography-meta text-muted-foreground flex items-center gap-2">
                    <Spinner className="h-3.5 w-3.5" />
                    {t('settings.providers.page.auth.oauth.waiting')}
                  </p>
                  <Button variant="ghost" size="xs" className="!font-normal shrink-0" onClick={cancel}>
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
                <p className="typography-meta text-muted-foreground">
                  {t('settings.providers.page.auth.oauth.waitingHint')}
                </p>
                {flow.attempt.paste && (
                  <div className="space-y-2">
                    <p className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.auth.oauth.pasteRedirectHint')}
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        value={redirectInput}
                        onChange={(event) => setRedirectInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void submitRedirect();
                        }}
                        placeholder={t('settings.providers.page.auth.oauth.pasteRedirectPlaceholder')}
                        aria-label={t('settings.providers.page.auth.oauth.pasteRedirectPlaceholder')}
                        className="font-mono text-xs"
                        disabled={redirectSubmit.submitting}
                      />
                      <Button
                        size="xs"
                        className="!font-normal shrink-0"
                        onClick={() => void submitRedirect()}
                        disabled={redirectSubmit.submitting || redirectInput.trim().length === 0}
                      >
                        {t('settings.providers.page.actions.complete')}
                      </Button>
                    </div>
                    <p className="typography-meta min-h-[1lh] text-[var(--status-error)]">
                      {redirectSubmit.error}
                    </p>
                  </div>
                )}
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
                <p dir="auto" className="typography-meta text-[var(--status-error)]">{flow.message}</p>
                {showStartButton ? (
                  <Button
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => beginConnect(method)}
                  >
                    {t('settings.providers.page.actions.tryAgain')}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
