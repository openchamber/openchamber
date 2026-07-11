import React from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { invokeDesktop, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { syncDesktopSettings, initializeAppearancePreferences } from '@/lib/persistence';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { ensureSettingsHydrated } from '@/lib/settingsStartup';
import { createRuntimeEndpointTransitionCoalescer } from '@/lib/runtime-endpoint-transition';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey, isRuntimeEndpointIdentityChange, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { desktopHostsGet, desktopHostsSet, getDesktopHostApiUrl, normalizeHostUrl } from '@/lib/desktopHosts';
import { resolveStatusCheckFailureState, type GateState } from './sessionAuthGateState';
import {
  authenticateWithPasskey,
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  isPasskeyCeremonyAbort,
  type PasskeyStatus,
  registerCurrentDevicePasskey,
} from '@/lib/passkeys';

const STATUS_CHECK_ENDPOINT = '/auth/session';
const TRUST_DEVICE_STORAGE_KEY = 'openchamber.uiAuth.trustDevice';
const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';

const readLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const sameOrigin = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeHostUrl(left);
  const normalizedRight = normalizeHostUrl(right);
  if (!normalizedLeft || !normalizedRight) return false;
  try {
    return new URL(normalizedLeft).origin === new URL(normalizedRight).origin;
  } catch {
    return false;
  }
};

const shouldIssueDesktopClientToken = (): boolean => {
  return isDesktopShell();
};

const isLoopbackHostname = (hostname: string): boolean => {
  const clean = hostname.replace(/^\[|\]$/g, '');
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
};

const isLocalDesktopRuntime = (): boolean => {
  if (!isDesktopShell()) return false;
  const localOrigin = readLocalOrigin();
  if (!localOrigin) return false;
  // An empty api base means same-origin requests against the page itself —
  // which on desktop IS the embedded local server. Requiring an exact origin
  // match here used to leave local client tokens untagged (no desktop-local
  // clientKind), and the server's client-create gate then 403'd them.
  const apiBaseUrl = getRuntimeApiBaseUrl();
  const effectiveTarget = apiBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  if (sameOrigin(localOrigin, effectiveTarget)) return true;
  // Loopback aliases (localhost vs 127.0.0.1) still address this machine's
  // own server.
  try {
    const normalized = normalizeHostUrl(effectiveTarget);
    return Boolean(normalized && isLoopbackHostname(new URL(normalized).hostname));
  } catch {
    return false;
  }
};

const desktopClientAuthMetadata = (): { clientKind?: string; dedupeKey?: string } => {
  if (!isLocalDesktopRuntime()) return {};
  return {
    clientKind: LOCAL_DESKTOP_CLIENT_KIND,
    dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY,
  };
};

const fetchSessionStatus = async (): Promise<Response> => {
  const response = await runtimeFetch(STATUS_CHECK_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  return response;
};

const readStoredTrustDevice = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(TRUST_DEVICE_STORAGE_KEY) === 'true';
};

const submitPassword = async (password: string, trustDevice: boolean): Promise<Response> => {
  const issueClientToken = shouldIssueDesktopClientToken();
  const response = await runtimeFetch(STATUS_CHECK_ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      password,
      trustDevice,
      issueClientToken,
      clientLabel: 'OpenChamber Desktop',
      ...desktopClientAuthMetadata(),
    }),
  });
  return response;
};

const issueDesktopClientToken = async (): Promise<string> => {
  if (!isDesktopShell()) {
    return '';
  }

  const response = await runtimeFetch('/api/client-auth/clients', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ label: 'OpenChamber Desktop', ...desktopClientAuthMetadata() }),
  }).catch(() => null);
  if (!response?.ok) {
    return '';
  }

  const payload = await response.json().catch(() => null) as { token?: unknown } | null;
  return typeof payload?.token === 'string' ? payload.token.trim() : '';
};

const shouldUseDesktopShellPasswordLogin = (): boolean => {
  return isDesktopShell() && !isLocalDesktopRuntime();
};

type DesktopPasswordLoginResult = {
  token: string;
  status?: number;
};

const issueDesktopClientTokenViaShell = async (password: string, trustDevice: boolean): Promise<DesktopPasswordLoginResult | null> => {
  if (!isDesktopShell() || typeof window === 'undefined') {
    return null;
  }
  const response = await invokeDesktop('desktop_remote_password_login', {
    url: getRuntimeApiBaseUrl(),
    password,
    trustDevice,
    requestHeaders: getRuntimeExtraHeadersSync(),
  }).catch(() => null);
  if (!response || typeof response !== 'object') {
    return null;
  }
  const token = (response as { token?: unknown }).token;
  const status = (response as { status?: unknown }).status;
  return {
    token: typeof token === 'string' ? token.trim() : '',
    ...(typeof status === 'number' ? { status } : {}),
  };
};

const persistDesktopClientToken = async (apiBaseUrl: string, clientToken: string): Promise<void> => {
  if (!isDesktopShell() || !clientToken) return;
  const cfg = await desktopHostsGet().catch(() => null);
  if (!cfg) return;
  if (cfg.localOrigin && sameOrigin(cfg.localOrigin, apiBaseUrl)) {
    await desktopHostsSet({
      hosts: cfg.hosts,
      defaultHostId: cfg.defaultHostId,
      initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
      localClientToken: clientToken,
    }).catch(() => undefined);
    return;
  }
  let changed = false;
  const hosts = cfg.hosts.map((host) => {
    if (!sameOrigin(getDesktopHostApiUrl(host), apiBaseUrl)) {
      return host;
    }
    if (host.clientToken === clientToken) {
      return host;
    }
    changed = true;
    return { ...host, clientToken };
  });
  if (!changed) return;
  await desktopHostsSet({
    hosts,
    defaultHostId: cfg.defaultHostId,
    initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
  }).catch(() => undefined);
};

const applyDesktopClientToken = async (clientToken: string): Promise<void> => {
  if (!clientToken) return;
  const apiBaseUrl = getRuntimeApiBaseUrl();
  const requestHeaders = getRuntimeExtraHeadersSync();
  await persistDesktopClientToken(apiBaseUrl, clientToken);
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken,
    requestHeaders: Object.keys(requestHeaders).length > 0 ? requestHeaders : null,
  });
};

const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const titlebarDragStyle = React.useMemo<React.CSSProperties>(() => {
    return {
      height: 'var(--oc-wco-titlebar-height, 0px)',
      right: 'var(--oc-wco-right-inset, 0px)',
    };
  }, []);

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground"
      style={{ fontFamily: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' }}
    >
      <div className="app-region-drag fixed left-0 top-0 z-20" style={titlebarDragStyle} aria-hidden />
      <div
        className="pointer-events-none absolute inset-0 opacity-55"
        style={{
          background: 'radial-gradient(120% 140% at 50% -20%, var(--surface-overlay) 0%, transparent 68%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor: 'var(--surface-subtle)',
          opacity: 0.22,
        }}
      />
      <div className="app-region-no-drag relative z-10 flex w-full justify-center px-4 py-12 sm:px-6">
        {children}
      </div>
    </div>
  );
};

const LoadingScreen: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
    <OpenChamberLogo width={120} height={120} />
  </div>
);

const ErrorScreen: React.FC<ErrorScreenProps> = ({ onRetry, errorType = 'network', retryAfter, children }) => {
  const { t } = useI18n();
  const isRateLimit = errorType === 'rate-limit';
  const minutes = retryAfter ? Math.ceil(retryAfter / 60) : 1;

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="typography-ui-header font-semibold text-destructive">
            {isRateLimit ? t('sessionAuth.error.rateLimitTitle') : t('sessionAuth.error.networkTitle')}
          </h1>
          <p className="typography-meta text-muted-foreground max-w-xs">
            {isRateLimit
              ? (minutes > 1
                ? t('sessionAuth.error.rateLimitDescriptionPlural', { minutes })
                : t('sessionAuth.error.rateLimitDescriptionSingle', { minutes }))
              : t('sessionAuth.error.networkDescription')}
          </p>
        </div>
        <Button type="button" onClick={onRetry} className="w-full max-w-xs">
          {t('sessionAuth.error.retry')}
        </Button>
        {children}
      </div>
    </AuthShell>
  );
};

interface SessionAuthGateProps {
  children: React.ReactNode;
}

interface ErrorScreenProps {
  onRetry: () => void;
  errorType?: 'network' | 'rate-limit';
  retryAfter?: number;
  children?: React.ReactNode;
}

export const SessionAuthGate: React.FC<SessionAuthGateProps> = ({
  children,
}) => {
  const { t } = useI18n();
  const vscodeRuntime = React.useMemo(() => isVSCodeRuntime(), []);
  const skipAuth = vscodeRuntime;
  const showHostSwitcher = React.useMemo(() => isDesktopShell() && !vscodeRuntime, [vscodeRuntime]);
  const [state, setState] = React.useState<GateState>(() => (skipAuth ? 'authenticated' : 'pending'));
  const [password, setPassword] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [retryAfter, setRetryAfter] = React.useState<number | undefined>(undefined);
  const [isTunnelLocked, setIsTunnelLocked] = React.useState(false);
  const [passkeyStatus, setPasskeyStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isPasskeyBusy, setIsPasskeyBusy] = React.useState(false);
  const [trustDevice, setTrustDevice] = React.useState<boolean>(() => readStoredTrustDevice());
  const [activePasskeyAction, setActivePasskeyAction] = React.useState<'auth' | 'register' | null>(null);
  const passwordInputRef = React.useRef<HTMLInputElement | null>(null);
  const hasResyncedRef = React.useRef(skipAuth);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(TRUST_DEVICE_STORAGE_KEY, trustDevice ? 'true' : 'false');
  }, [trustDevice]);

  const refreshPasskeyStatus = React.useCallback(async () => {
    if (skipAuth) {
      return defaultPasskeyStatus;
    }

    try {
      const nextStatus = await fetchPasskeyStatus();
      setPasskeyStatus(nextStatus);
      return nextStatus;
    } catch {
      setPasskeyStatus(defaultPasskeyStatus);
      return defaultPasskeyStatus;
    }
  }, [skipAuth]);

  React.useEffect(() => {
    let cancelled = false;

    if (skipAuth) {
      return;
    }

    void (async () => {
      try {
        if (!window.isSecureContext || !browserSupportsWebAuthn()) {
          if (!cancelled) {
            setSupportsPasskeys(false);
          }
          return;
        }
        if (!cancelled) {
          setSupportsPasskeys(true);
        }
      } catch {
        if (!cancelled) {
          setSupportsPasskeys(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skipAuth]);

  const checkStatus = React.useCallback(async () => {
    if (skipAuth) {
      setState('authenticated');
      return;
    }

    setState((prev) => (prev === 'authenticated' ? prev : 'pending'));
    try {
      const [response, latestPasskeyStatus] = await Promise.all([
        fetchSessionStatus(),
        refreshPasskeyStatus(),
      ]);
      const responseText = await response.text();
      
        if (response.ok) {
          setState('authenticated');
          setIsTunnelLocked(false);
          setErrorMessage('');
          setRetryAfter(undefined);
          return;
        }
        if (response.status === 401) {
          let data: { tunnelLocked?: boolean; debug?: { hasRefreshToken: boolean; message: string } } = {};
          try {
            data = JSON.parse(responseText);
          } catch {
            data = {};
          }
          setIsTunnelLocked(data.tunnelLocked === true);
          setPasskeyStatus(latestPasskeyStatus);
          setState('locked');
          setRetryAfter(undefined);
          return;
        }
      if (response.status === 429) {
        let data: { retryAfter?: number } = {};
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }
        setRetryAfter(data.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }
      setState('error');
      setIsTunnelLocked(false);
    } catch (error) {
      console.warn('Failed to check session status:', error);
      if (resolveStatusCheckFailureState({ shouldUseDesktopShellPasswordLogin: shouldUseDesktopShellPasswordLogin() }) === 'locked') {
        setState('locked');
        setRetryAfter(undefined);
        setIsTunnelLocked(false);
        return;
      }
      setState('error');
      setIsTunnelLocked(false);
    }
  }, [refreshPasskeyStatus, skipAuth]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    void checkStatus();
  }, [checkStatus, skipAuth]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }

    const transitions = createRuntimeEndpointTransitionCoalescer((detail: Parameters<typeof isRuntimeEndpointIdentityChange>[0]) => {
      if (!isRuntimeEndpointIdentityChange(detail)) {
        return;
      }
      setPassword('');
      setErrorMessage('');
      setRetryAfter(undefined);
      setIsTunnelLocked(false);
      setState('pending');
      void checkStatus();
    });
    const unsubscribe = subscribeRuntimeEndpointChanged((detail) => transitions.schedule(detail));
    return () => {
      unsubscribe();
      transitions.cancel();
    };
  }, [checkStatus, skipAuth]);

  React.useEffect(() => {
    if (!skipAuth && state === 'locked') {
      hasResyncedRef.current = false;
    }
  }, [skipAuth, state]);

  React.useEffect(() => {
    if (state === 'locked' && passwordInputRef.current) {
      passwordInputRef.current.focus();
      passwordInputRef.current.select();
    }
  }, [state]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    if (state === 'authenticated' && !hasResyncedRef.current) {
      hasResyncedRef.current = true;
      void ensureSettingsHydrated({
        runtimeKey: getRuntimeKey(),
        initializeAppearance: initializeAppearancePreferences,
        syncSettings: syncDesktopSettings,
        applyDirectory: applyPersistedDirectoryPreferences,
        onError: (stage, error) => {
          console.error(`[SessionAuthGate] ${stage} settings hydration failed:`, error);
        },
      });
    }
  }, [skipAuth, state]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await handlePasswordUnlock(false);
  };

  const registerPasskeyForCurrentSession = React.useCallback(async () => {
    setActivePasskeyAction('register');
    setIsPasskeyBusy(true);
    try {
      await registerCurrentDevicePasskey();
    } finally {
      setActivePasskeyAction(null);
      setIsPasskeyBusy(false);
    }
    await refreshPasskeyStatus();
  }, [refreshPasskeyStatus]);

  const cancelActivePasskey = React.useCallback(() => {
    cancelPasskeyCeremony();
    setActivePasskeyAction(null);
    setIsPasskeyBusy(false);
  }, []);

  const handlePasswordUnlock = React.useCallback(async (enrollPasskey: boolean) => {
    if (isTunnelLocked) {
      return;
    }
    if (!password || isSubmitting) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      if (shouldUseDesktopShellPasswordLogin()) {
        const shellLogin = await issueDesktopClientTokenViaShell(password, trustDevice);
        if (shellLogin?.token) {
          setPassword('');
          setIsTunnelLocked(false);
          await applyDesktopClientToken(shellLogin.token);
          setState('authenticated');
          return;
        }
        if (shellLogin?.status === 401) {
          setErrorMessage(t('sessionAuth.error.incorrectPassword'));
          setIsTunnelLocked(false);
          setState('locked');
          return;
        }
        if (shellLogin?.status === 429) {
          setRetryAfter(undefined);
          setIsTunnelLocked(false);
          setState('rate-limited');
          return;
        }
      }

      const response = await submitPassword(password, trustDevice);
      if (response.ok) {
        const payload = await response.json().catch(() => null) as { clientToken?: unknown } | null;
        const shouldUseClientToken = shouldIssueDesktopClientToken();
        let clientToken = '';
        if (shouldUseClientToken) {
          clientToken = typeof payload?.clientToken === 'string' && payload.clientToken.trim()
            ? payload.clientToken.trim()
            : '';
          if (!clientToken) {
            const shellLogin = await issueDesktopClientTokenViaShell(password, trustDevice);
            clientToken = shellLogin?.token || await issueDesktopClientToken();
          }
        }
        setPassword('');
        setIsTunnelLocked(false);
        if (clientToken) {
          await applyDesktopClientToken(clientToken);
        }
        if (enrollPasskey && supportsPasskeys) {
          try {
            await registerPasskeyForCurrentSession();
            toast.success(t('sessionAuth.toast.passkeyAdded'));
            setState('authenticated');
            return;
          } catch (error) {
            if (isPasskeyCeremonyAbort(error)) {
              toast.message(t('sessionAuth.toast.passkeySetupCanceled'));
            } else {
              const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySetupFailed');
              toast.error(message);
            }
            setState('authenticated');
            return;
          }
        }
        setState('authenticated');
        return;
      }

      if (response.status === 401) {
        setErrorMessage(t('sessionAuth.error.incorrectPassword'));
        setIsTunnelLocked(false);
        setState('locked');
        return;
      }

      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        setRetryAfter(data.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }

      setErrorMessage(t('sessionAuth.error.unexpectedResponse'));
      setIsTunnelLocked(false);
      setState('error');
    } catch (error) {
      console.warn('Failed to submit UI password:', error);
      const shellLogin = shouldUseDesktopShellPasswordLogin()
        ? await issueDesktopClientTokenViaShell(password, trustDevice)
        : null;
      if (shellLogin?.token) {
        setPassword('');
        setIsTunnelLocked(false);
        await applyDesktopClientToken(shellLogin.token);
        setState('authenticated');
        return;
      }
      if (shellLogin?.status === 401) {
        setErrorMessage(t('sessionAuth.error.incorrectPassword'));
        setIsTunnelLocked(false);
        setState('locked');
        return;
      }
      if (shellLogin?.status === 429) {
        setRetryAfter(undefined);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }
      setErrorMessage(t('sessionAuth.error.networkRetry'));
      setIsTunnelLocked(false);
      setState('error');
    } finally {
      setIsSubmitting(false);
    }
  }, [cancelActivePasskey, isPasskeyBusy, isSubmitting, isTunnelLocked, password, registerPasskeyForCurrentSession, supportsPasskeys, t, trustDevice]);

  const handlePasskeyUnlock = React.useCallback(async () => {
    if (isSubmitting || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    setIsPasskeyBusy(true);
    setActivePasskeyAction('auth');
    setErrorMessage('');

    try {
      const payload = await authenticateWithPasskey(trustDevice, {
        issueClientToken: shouldIssueDesktopClientToken(),
        clientLabel: 'OpenChamber Desktop',
        ...desktopClientAuthMetadata(),
      }) as { clientToken?: unknown } | null;
      const clientToken = shouldIssueDesktopClientToken() && typeof payload?.clientToken === 'string' && payload.clientToken.trim()
        ? payload.clientToken.trim()
        : '';
      if (clientToken) {
        await applyDesktopClientToken(clientToken);
      }

      setPassword('');
      setState('authenticated');
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        setErrorMessage('');
      } else {
        const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySignInCanceled');
        setErrorMessage(message);
      }
    } finally {
      setActivePasskeyAction(null);
      setIsPasskeyBusy(false);
    }
  }, [cancelActivePasskey, isPasskeyBusy, isSubmitting, supportsPasskeys, t, trustDevice]);

  const handlePasskeySetupOnly = React.useCallback(async () => {
    if (isSubmitting || isTunnelLocked || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    if (state !== 'authenticated') {
      if (!password) {
        setErrorMessage(t('sessionAuth.error.enterPasswordForPasskey'));
        return;
      }
      await handlePasswordUnlock(true);
      return;
    }

    setErrorMessage('');
    try {
      await registerPasskeyForCurrentSession();
      toast.success(t('sessionAuth.toast.passkeyAdded'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('sessionAuth.toast.passkeySetupCanceled'));
        return;
      }
      const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySetupFailed');
      toast.error(message);
    }
  }, [cancelActivePasskey, handlePasswordUnlock, isPasskeyBusy, isSubmitting, isTunnelLocked, password, registerPasskeyForCurrentSession, state, supportsPasskeys, t]);

  const canOfferPasskeySetup = supportsPasskeys && passkeyStatus.enabled;
  const canUsePasskey = canOfferPasskeySetup && passkeyStatus.hasPasskeys;

  if (state === 'pending') {
    return <LoadingScreen />;
  }

  if (state === 'error') {
    return (
      <ErrorScreen onRetry={() => void checkStatus()} errorType="network">
        {showHostSwitcher && (
          <div className="w-full max-w-xs">
            <DesktopHostSwitcherInline />
            <p className="mt-1 text-center typography-micro text-muted-foreground">
              {t('sessionAuth.locked.hostSwitcherHint')}
            </p>
          </div>
        )}
      </ErrorScreen>
    );
  }

  if (state === 'rate-limited') {
    return <ErrorScreen onRetry={() => void checkStatus()} errorType="rate-limit" retryAfter={retryAfter} />;
  }

  if (state === 'locked') {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-6 w-full max-w-xs">
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-xl font-semibold text-foreground">
              {isTunnelLocked ? t('sessionAuth.locked.tunnelTitle') : t('sessionAuth.locked.unlockTitle')}
            </h1>
            <p className="typography-meta text-muted-foreground">
              {isTunnelLocked
                ? t('sessionAuth.locked.tunnelDescription')
                : t('sessionAuth.locked.passwordDescription')}
            </p>
          </div>

          {!isTunnelLocked && (
            <form onSubmit={handleSubmit} className="w-full space-y-2">
              {canUsePasskey && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void handlePasskeyUnlock()}
                  disabled={isSubmitting || (isPasskeyBusy && activePasskeyAction !== 'auth')}
                >
                  {isPasskeyBusy ? (
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon name="lock-unlock" className="h-4 w-4" />
                  )}
                  <span>{isPasskeyBusy && activePasskeyAction === 'auth'
                    ? t('sessionAuth.actions.cancelPasskey')
                    : t('sessionAuth.actions.usePasskey')}</span>
                </Button>
              )}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Icon name="lock" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                  <Input
                    id="openchamber-ui-password"
                    ref={passwordInputRef}
                    type="password"
                    autoComplete="current-password"
                    placeholder={t('sessionAuth.password.placeholder')}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (errorMessage) {
                        setErrorMessage('');
                      }
                    }}
                    className="pl-10"
                    aria-invalid={Boolean(errorMessage) || undefined}
                    aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
                    disabled={isSubmitting}
                  />
                </div>
                <Button
                  type="submit"
                  size="icon"
                  disabled={!password || isSubmitting}
                  aria-label={isSubmitting ? t('sessionAuth.actions.unlockingAria') : t('sessionAuth.actions.unlockAria')}
                >
                  {isSubmitting ? (
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon name="lock-unlock" className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {canOfferPasskeySetup ? (
                <div className="flex items-center justify-between pt-1">
                  <label className="flex items-center gap-2 text-center typography-micro text-muted-foreground">
                    <Checkbox
                      checked={trustDevice}
                      onChange={setTrustDevice}
                      disabled={isSubmitting}
                      ariaLabel={t('sessionAuth.actions.trustDeviceAria')}
                      className="size-4"
                      iconClassName="size-4"
                    />
                    <span>{t('sessionAuth.actions.trustDevice')}</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => void handlePasskeySetupOnly()}
                    disabled={isSubmitting}
                  >
                    {isPasskeyBusy && activePasskeyAction === 'register'
                      ? t('sessionAuth.actions.cancelPasskeySetup')
                      : t('sessionAuth.actions.addPasskey')}
                  </Button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
                  <Checkbox
                    checked={trustDevice}
                    onChange={setTrustDevice}
                    disabled={isSubmitting}
                    ariaLabel={t('sessionAuth.actions.trustDeviceAria')}
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span>{t('sessionAuth.actions.trustDevice')}</span>
                </label>
              )}
              {errorMessage && (
                <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                  {errorMessage}
                </p>
              )}
            </form>
          )}

          {showHostSwitcher && (
            <div className="w-full">
              <DesktopHostSwitcherInline />
              <p className="mt-1 text-center typography-micro text-muted-foreground">
                {t('sessionAuth.locked.hostSwitcherHint')}
              </p>
            </div>
          )}
        </div>
      </AuthShell>
    );
  }

  return <>{children}</>;
};
