import React from 'react';
import { RiLockLine, RiLockUnlockLine, RiLoader4Line } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { syncDesktopSettings, initializeAppearancePreferences } from '@/lib/persistence';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';

const STATUS_CHECK_ENDPOINT = '/auth/session';

const fetchSessionStatus = async (): Promise<Response> => {
  console.log('[Frontend Auth] Checking session status...');
  const response = await fetch(STATUS_CHECK_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  console.log('[Frontend Auth] Session status response:', response.status, response.statusText);
  return response;
};

const submitPassword = async (password: string): Promise<Response> => {
  console.log('[Frontend Auth] Submitting password...');
  const response = await fetch(STATUS_CHECK_ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  console.log('[Frontend Auth] Password submit response:', response.status, response.statusText);
  return response;
};

const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground"
    style={{ fontFamily: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' }}
  >
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
    <div className="relative z-10 flex w-full justify-center px-4 py-12 sm:px-6">
      {children}
    </div>
  </div>
);

const LoadingScreen: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
    <OpenChamberLogo width={120} height={120} />
  </div>
);

const ErrorScreen: React.FC<ErrorScreenProps> = ({ onRetry, errorType = 'network', retryAfter }) => {
  const isRateLimit = errorType === 'rate-limit';
  const minutes = retryAfter ? Math.ceil(retryAfter / 60) : 1;

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="typography-ui-header font-semibold text-destructive">
            {isRateLimit ? 'Too many attempts' : 'Unable to reach server'}
          </h1>
          <p className="typography-meta text-muted-foreground max-w-xs">
            {isRateLimit
              ? `Please wait ${minutes} minute${minutes > 1 ? 's' : ''} before trying again.`
              : "We couldn't verify the UI session. Check that the service is running and try again."}
          </p>
        </div>
        <Button type="button" onClick={onRetry} className="w-full max-w-xs">
          Retry
        </Button>
      </div>
    </AuthShell>
  );
};

interface SessionAuthGateProps {
  children: React.ReactNode;
}

type GateState = 'pending' | 'authenticated' | 'locked' | 'error' | 'rate-limited';

interface ErrorScreenProps {
  onRetry: () => void;
  errorType?: 'network' | 'rate-limit';
  retryAfter?: number;
}

export const SessionAuthGate: React.FC<SessionAuthGateProps> = ({ children }) => {
  const vscodeRuntime = React.useMemo(() => isVSCodeRuntime(), []);
  const skipAuth = vscodeRuntime;
  const showHostSwitcher = React.useMemo(() => isDesktopShell() && !vscodeRuntime, [vscodeRuntime]);
  const [state, setState] = React.useState<GateState>(() => (skipAuth ? 'authenticated' : 'pending'));
  const [password, setPassword] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [retryAfter, setRetryAfter] = React.useState<number | undefined>(undefined);
  const [isTunnelLocked, setIsTunnelLocked] = React.useState(false);
  const passwordInputRef = React.useRef<HTMLInputElement | null>(null);
  const hasResyncedRef = React.useRef(skipAuth);

  const checkStatus = React.useCallback(async () => {
    if (skipAuth) {
      console.log('[Frontend Auth] VSCode runtime, skipping auth');
      setState('authenticated');
      return;
    }

    // 检查 cookie 是否存在
    const cookies = document.cookie;
    const hasAccessToken = cookies.includes('oc_ui_session=');
    const hasRefreshToken = cookies.includes('oc_ui_refresh=');
    console.log('[Frontend Auth] Cookies check - access:', hasAccessToken, 'refresh:', hasRefreshToken);
    console.log('[Frontend Auth] All cookies:', cookies.split(';').map(c => c.trim().split('=')[0]));

    setState((prev) => (prev === 'authenticated' ? prev : 'pending'));
    try {
      const response = await fetchSessionStatus();
      const responseText = await response.text();
      console.log('[Frontend Auth] Raw response:', response.status, responseText);
      
        if (response.ok) {
          console.log('[Frontend Auth] Session is authenticated');
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
        console.warn('[Frontend Auth] Session is locked (401)', data);
          if (data.debug) {
            console.warn('[Frontend Auth] Debug info:', data.debug);
          }
          setIsTunnelLocked(data.tunnelLocked === true);
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
      console.error('[Frontend Auth] Unexpected response status:', response.status);
      setState('error');
      setIsTunnelLocked(false);
    } catch (error) {
      console.warn('Failed to check session status:', error);
      setState('error');
      setIsTunnelLocked(false);
    }
  }, [skipAuth]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    void checkStatus();
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
      void (async () => {
        await syncDesktopSettings();
        await initializeAppearancePreferences();
        await applyPersistedDirectoryPreferences();
      })();
    }
  }, [skipAuth, state]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTunnelLocked) {
      return;
    }
    if (!password || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const response = await submitPassword(password);
      if (response.ok) {
        console.log('[Frontend Auth] Login successful');
        // 检查登录后 cookie 是否被设置
        const cookies = document.cookie;
        const hasAccessToken = cookies.includes('oc_ui_session=');
        const hasRefreshToken = cookies.includes('oc_ui_refresh=');
        console.log('[Frontend Auth] After login - access:', hasAccessToken, 'refresh:', hasRefreshToken);
        console.log('[Frontend Auth] All cookies after login:', cookies.split(';').map(c => c.trim().split('=')[0]).filter(Boolean));
        setPassword('');
        setIsTunnelLocked(false);
        setState('authenticated');
        return;
      }

      if (response.status === 401) {
        console.warn('[Frontend Auth] Login failed: Invalid password');
        setErrorMessage('Incorrect password. Try again.');
        setIsTunnelLocked(false);
        setState('locked');
        return;
      }

      if (response.status === 429) {
        console.warn('[Frontend Auth] Login failed: Rate limited');
        const data = await response.json().catch(() => ({}));
        setRetryAfter(data.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }

      console.error('[Frontend Auth] Login failed: Unexpected response', response.status);
      setErrorMessage('Unexpected response from server.');
      setIsTunnelLocked(false);
      setState('error');
    } catch (error) {
      console.warn('Failed to submit UI password:', error);
      setErrorMessage('Network error. Check connection and retry.');
      setIsTunnelLocked(false);
      setState('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (state === 'pending') {
    return <LoadingScreen />;
  }

  if (state === 'error') {
    return <ErrorScreen onRetry={() => void checkStatus()} errorType="network" />;
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
              {isTunnelLocked ? 'Tunnel access required' : 'Unlock OpenChamber'}
            </h1>
            <p className="typography-meta text-muted-foreground">
              {isTunnelLocked
                ? 'Open this tunnel using the one-time connect link from the desktop app.'
                : 'This session is password-protected.'}
            </p>
          </div>

          {!isTunnelLocked && (
            <form onSubmit={handleSubmit} className="w-full space-y-2" data-keyboard-avoid="true">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <RiLockLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                  <Input
                    id="openchamber-ui-password"
                    ref={passwordInputRef}
                    type="password"
                    autoComplete="current-password"
                    placeholder="Enter password"
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
                  aria-label={isSubmitting ? 'Unlocking' : 'Unlock'}
                >
                  {isSubmitting ? (
                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                  ) : (
                    <RiLockUnlockLine className="h-4 w-4" />
                  )}
                </Button>
              </div>
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
                Use Local if remote is unreachable.
              </p>
            </div>
          )}
        </div>
      </AuthShell>
    );
  }

  return <>{children}</>;
};
