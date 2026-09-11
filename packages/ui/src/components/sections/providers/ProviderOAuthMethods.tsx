import React from 'react';
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
  collectPromptInputs,
  defaultPromptValues,
  describeOAuthError,
  firstUnansweredPrompt,
  parseAuthPrompts,
  parseAuthorization,
  shouldOpenAuthorizationUrl,
  visiblePrompts,
  type AuthPrompt,
  type OAuthAuthorization,
} from './provider-oauth';

export interface ProviderOAuthMethod {
  /** Index into the provider's full auth-method list, which is what OpenCode's `method` parameter addresses. */
  index: number;
  label: string;
  prompts?: unknown;
}

interface ProviderOAuthMethodsProps {
  providerId: string;
  methods: ProviderOAuthMethod[];
  /** Called once a credential has been stored, so the caller can reload providers. */
  onConnected: () => void | Promise<void>;
  /** Layout only — the caller owns separation from whatever sits above. */
  className?: string;
}

type Flow =
  | { phase: 'idle' }
  | { phase: 'prompting'; methodIndex: number; prompts: AuthPrompt[]; error: string | null }
  | { phase: 'authorizing'; methodIndex: number }
  /** `auto`: the callback request is in flight and blocks until the browser sign-in finishes. */
  | { phase: 'waiting'; methodIndex: number; authorization: OAuthAuthorization }
  /** `code`: waiting for the user to paste a code out of the browser. */
  | { phase: 'awaitingCode'; methodIndex: number; authorization: OAuthAuthorization; submitting: boolean }
  | { phase: 'failed'; methodIndex: number; message: string };

const IDLE: Flow = { phase: 'idle' };

/**
 * OAuth sign-in for a provider's auth methods.
 *
 * The completion method reported by `authorize` drives everything: `auto`
 * chains straight into `callback` and holds it open until the user finishes in
 * the browser, `code` collects a pasted code first. See `provider-oauth.ts`.
 *
 * Only one method can run at a time, and the in-flight callback is aborted when
 * this component unmounts. Mount it with `key={providerId}` so switching
 * providers starts from a clean flow.
 */
export const ProviderOAuthMethods: React.FC<ProviderOAuthMethodsProps> = ({
  providerId,
  methods,
  onConnected,
  className,
}) => {
  const { t } = useI18n();
  const [flow, setFlow] = React.useState<Flow>(IDLE);
  const [promptValues, setPromptValues] = React.useState<Record<string, string>>({});
  const [codeInput, setCodeInput] = React.useState('');
  const callbackAbortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => callbackAbortRef.current?.abort(), []);

  const activeIndex = flow.phase === 'idle' ? null : flow.methodIndex;
  const busy = flow.phase === 'authorizing'
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

  /**
   * Runs the blocking half of the flow. Never throws: the caller has already
   * handed control to the user, so a failure here is a flow state, not an
   * exception to unwind.
   */
  const runCallback = async (methodIndex: number, code?: string) => {
    const controller = new AbortController();
    callbackAbortRef.current?.abort();
    callbackAbortRef.current = controller;

    try {
      const result = await opencodeClient.getSdkClient().provider.oauth.callback(
        {
          providerID: providerId,
          method: methodIndex,
          ...(code ? { code } : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        return;
      }
      if (result.error) {
        throw result.error;
      }

      setFlow(IDLE);
      toast.success(t('settings.providers.page.toast.oauthCompleted'));
      await onConnected();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      console.error('Failed to complete OAuth flow:', error);
      setFlow({
        phase: 'failed',
        methodIndex,
        message: describeOAuthError(error, t, 'settings.providers.page.toast.oauthCompleteFailed'),
      });
    } finally {
      if (callbackAbortRef.current === controller) {
        callbackAbortRef.current = null;
      }
    }
  };

  const runAuthorize = async (methodIndex: number, inputs: Record<string, string>) => {
    setFlow({ phase: 'authorizing', methodIndex });

    let authorization: OAuthAuthorization;
    try {
      const result = await opencodeClient.getSdkClient().provider.oauth.authorize({
        providerID: providerId,
        method: methodIndex,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      });
      if (result.error) {
        throw result.error;
      }

      const parsed = parseAuthorization(result.data);
      if (!parsed) {
        setFlow({
          phase: 'failed',
          methodIndex,
          message: t('settings.providers.page.toast.oauthDetailsMissing'),
        });
        return;
      }
      authorization = parsed;
    } catch (error) {
      console.error('Failed to start OAuth flow:', error);
      setFlow({
        phase: 'failed',
        methodIndex,
        message: describeOAuthError(error, t, 'settings.providers.page.toast.oauthStartFailed'),
      });
      return;
    }

    // Claude Code CLI owns its OAuth flow and opens the browser itself. Its
    // plugin URL is informational only; opening it creates a misleading docs
    // tab alongside the real sign-in page.
    if (authorization.url && shouldOpenAuthorizationUrl(providerId, authorization.url)) {
      void openExternalUrl(authorization.url);
    }

    if (authorization.method === 'code') {
      setCodeInput('');
      setFlow({ phase: 'awaitingCode', methodIndex, authorization, submitting: false });
      return;
    }

    setFlow({ phase: 'waiting', methodIndex, authorization });
    await runCallback(methodIndex);
  };

  const beginConnect = (method: ProviderOAuthMethod) => {
    const prompts = parseAuthPrompts(method.prompts);
    if (prompts.length === 0) {
      void runAuthorize(method.index, {});
      return;
    }
    setPromptValues(defaultPromptValues(prompts));
    setFlow({ phase: 'prompting', methodIndex: method.index, prompts, error: null });
  };

  const submitPrompts = () => {
    if (flow.phase !== 'prompting') {
      return;
    }
    const unanswered = firstUnansweredPrompt(flow.prompts, promptValues);
    if (unanswered) {
      setFlow({
        ...flow,
        error: t('settings.providers.page.auth.oauth.promptRequired', { field: unanswered.message }),
      });
      return;
    }
    void runAuthorize(flow.methodIndex, collectPromptInputs(flow.prompts, promptValues));
  };

  const submitCode = () => {
    if (flow.phase !== 'awaitingCode') {
      return;
    }
    const code = codeInput.trim();
    if (!code) {
      return;
    }
    setFlow({ ...flow, submitting: true });
    void runCallback(flow.methodIndex, code);
  };

  /**
   * Stops tracking the attempt. Upstream keeps its pending authorization until
   * a new `authorize` replaces it, so reconnecting is always safe.
   */
  const cancel = () => {
    callbackAbortRef.current?.abort();
    callbackAbortRef.current = null;
    setFlow(IDLE);
  };

  const renderPrompt = (prompt: AuthPrompt) => {
    const value = promptValues[prompt.key] ?? '';
    const setValue = (next: string) =>
      setPromptValues((prev) => ({ ...prev, [prompt.key]: next }));

    return (
      <div key={prompt.key} className="space-y-1.5">
        <label className="typography-ui-label text-foreground">{prompt.message}</label>
        {prompt.type === 'select' ? (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
              <SelectValue>
                {(current) => prompt.options.find((option) => option.value === current)?.label ?? null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {prompt.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.hint ? `${option.label} · ${option.hint}` : option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={prompt.placeholder}
            className="max-w-[24rem] text-xs"
          />
        )}
      </div>
    );
  };

  const renderAuthorizationDetails = (authorization: OAuthAuthorization) => (
    <>
      {authorization.instructions && (
        <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
          {authorization.instructions}
        </p>
      )}

      {authorization.userCode && (
        <div className="flex items-center gap-2">
          <Input
            value={authorization.userCode}
            readOnly
            aria-label={t('settings.providers.page.auth.oauth.deviceCodeLabel')}
            className="font-mono text-center tracking-widest"
          />
          <Button
            variant="outline"
            size="xs"
            className="!font-normal shrink-0"
            onClick={() => void copy(
              authorization.userCode ?? '',
              'settings.providers.page.toast.deviceCodeCopied',
              'settings.providers.page.toast.deviceCodeCopyFailed',
            )}
          >
            {t('settings.providers.page.actions.copyCode')}
          </Button>
        </div>
      )}

      {authorization.url && (
        <div className="flex items-center gap-2">
          <Input
            value={authorization.url}
            readOnly
            aria-label={t('settings.providers.page.auth.oauth.linkLabel')}
            className="text-xs text-muted-foreground"
          />
          <div className="flex gap-1 shrink-0">
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => void openExternalUrl(authorization.url ?? '')}
            >
              {t('settings.providers.page.actions.open')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => void copy(
                authorization.url ?? '',
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

  return (
    <div className={cn('space-y-4', className)}>
      {methods.map((method) => {
        const isActive = activeIndex === method.index;

        return (
          <div key={method.index} className="space-y-3">
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
                {visiblePrompts(flow.prompts, promptValues).map(renderPrompt)}
                {flow.error && (
                  <p className="typography-meta text-[var(--status-error)]">{flow.error}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button size="xs" className="!font-normal" onClick={submitPrompts}>
                    {t('settings.providers.page.actions.continue')}
                  </Button>
                  <Button variant="ghost" size="xs" className="!font-normal" onClick={cancel}>
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {isActive && flow.phase === 'authorizing' && (
              <p className="typography-meta text-muted-foreground flex items-center gap-2">
                <Icon name="loader" className="h-3.5 w-3.5 animate-spin" />
                {t('settings.providers.page.auth.oauth.starting')}
              </p>
            )}

            {isActive && flow.phase === 'waiting' && (
              <div className="space-y-3">
                {renderAuthorizationDetails(flow.authorization)}
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
                {renderAuthorizationDetails(flow.authorization)}
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
                    onClick={submitCode}
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
