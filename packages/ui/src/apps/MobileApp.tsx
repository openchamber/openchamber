import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { McpIcon } from '@/components/icons/McpIcon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { Button } from '@/components/ui/button';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ChatView } from '@/components/views/ChatView';
import { SettingsView } from '@/components/views/SettingsView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useRouter } from '@/hooks/useRouter';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry, RuntimeAPIs } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { clampPercent, formatQuotaResetLabel, formatQuotaValueLabel, formatWindowLabel, QUOTA_PROVIDERS, resolveUsageTone } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import type { QuotaProviderId, UsageWindow } from '@/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider, useSession, useSessionMessages } from '@/sync/sync-context';

import { SyncAppEffects } from './AppEffects';
import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobileSurfaceShell } from './MobileSurfaceShell';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { isSameConnectionUrl, useMobileConnection } from './mobileConnections';
import { isQrScanSupported, parseConnectionPayload, scanConnectionQr } from './mobileQrScan';
import { resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';

const MOBILE_SETTINGS_PAGES = [
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'git',
  'magic-prompts',
  'behavior',
  'mcp',
  'providers',
  'usage',
  'voice',
  'about',
] as const;

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const isCapacitorMobileApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const maybeCapacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (maybeCapacitor?.isNativePlatform?.() === true) return true;
  return window.location.protocol === 'capacitor:';
};

const useNativeMobileChrome = (): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const root = document.documentElement;
    // Marks the Capacitor shell so keyboard-inset CSS only applies here, not in
    // the browser-hosted PWA (which handles the keyboard via dvh / interactive-widget).
    root.classList.add('oc-capacitor-app');

    const setInset = (px: number) => {
      root.style.setProperty('--oc-keyboard-inset', `${Math.max(0, Math.round(px))}px`);
    };

    void import('@capacitor/status-bar').then(async ({ StatusBar, Style }) => {
      if (disposed) return;
      // Keep the status bar transparent over the WebView. A custom UIScene lifecycle
      // (iOS 26) plus returning from background can silently drop the overlay state,
      // letting an opaque status-bar background flash in at the top — so re-assert it
      // on mount, once shortly after (startup race), and whenever the app re-activates.
      const applyStatusBar = async () => {
        await StatusBar.setStyle({ style: Style.Default }).catch(() => undefined);
        await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
        await StatusBar.show().catch(() => undefined);
      };
      await applyStatusBar();
      const retry = window.setTimeout(() => void applyStatusBar(), 400);
      cleanup.push(() => window.clearTimeout(retry));

      const { App } = await import('@capacitor/app');
      const stateHandle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void applyStatusBar();
      });
      if (disposed) {
        void stateHandle.remove();
        return;
      }
      cleanup.push(() => void stateHandle.remove());
    }).catch(() => undefined);

    void import('@capacitor/keyboard').then(async ({ Keyboard }) => {
      if (disposed) return;
      await Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => undefined);

      // `keyboardWillShow` fires at the START of the iOS keyboard animation and
      // carries the final height, so we set the inset once here and let the CSS
      // transition (tuned to mimic the iOS keyboard curve/duration) carry the rise.
      // visualViewport tracking was tried but doesn't shrink under WKWebView's
      // `resize: 'none'`, so it never reported the keyboard — this event is the
      // reliable signal.
      const showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
        root.classList.add('oc-keyboard-open');
        setInset(info.keyboardHeight);
      });
      const hideHandle = await Keyboard.addListener('keyboardWillHide', () => {
        root.classList.remove('oc-keyboard-open');
        setInset(0);
      });
      if (disposed) {
        void showHandle.remove();
        void hideHandle.remove();
        return;
      }
      cleanup.push(() => void showHandle.remove(), () => void hideHandle.remove());
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
      root.classList.remove('oc-capacitor-app', 'oc-keyboard-open');
      root.style.removeProperty('--oc-keyboard-inset');
    };
  }, []);
};

const useNativeMobileLifecycle = (onResume: () => void): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const state = await App.addListener('appStateChange', ({ isActive }) => {
        document.documentElement.classList.toggle('oc-native-app-active', isActive);
        if (isActive) onResume();
      });
      const resume = await App.addListener('resume', onResume);
      if (disposed) {
        void state.remove();
        void resume.remove();
        return;
      }
      cleanup.push(() => void state.remove(), () => void resume.remove());
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, [onResume]);
};

const useNativeAndroidBackButton = (onBack: () => boolean): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    let remove: (() => void) | null = null;

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const listener = await App.addListener('backButton', () => {
        if (onBack()) return;
        void App.minimizeApp().catch(() => undefined);
      });
      if (disposed) {
        void listener.remove();
        return;
      }
      remove = () => void listener.remove();
    }).catch(() => undefined);

    return () => {
      disposed = true;
      remove?.();
    };
  }, [onBack]);
};

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getNumericLimit = (limit: unknown, key: 'context' | 'output'): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const getTokenCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
};

type OverflowItem = {
  key: 'files' | 'changes' | 'mcp' | 'instances' | 'update' | 'settings';
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  badge?: number;
  onSelect: () => void;
};

type ContextDisplay = {
  percentage: number;
  tokens: string;
  colorClass: string;
} | null;

const getProjectDisplayLabel = (project: ProjectEntry | null, fallbackDirectory: string): string => {
  if (project) return project.label?.trim() || getProjectLabel(project.path);
  return getProjectLabel(fallbackDirectory);
};

const MobileConnectionWelcome: React.FC<{ onConnected: () => void }> = ({ onConnected }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnected);
  const { connections, isBusy, isPasswordBusy, error, pendingConnection } = conn;
  const [serverUrl, setServerUrl] = React.useState('');
  const [connectionName, setConnectionName] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  const [password, setPassword] = React.useState('');

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.connect({ url: serverUrl, clientToken, label: connectionName });
  }, [clientToken, conn, connectionName, serverUrl]);

  // Accept a pasted pairing link (openchamber://connect?...) in the URL field and
  // split it back into the server URL + token, revealing the token field when present.
  const handleUrlChange = React.useCallback((value: string) => {
    if (/^openchamber:\/\//i.test(value.trim())) {
      const payload = parseConnectionPayload(value);
      if (payload) {
        setServerUrl(payload.url);
        if (payload.label) setConnectionName(payload.label);
        if (payload.clientToken) setClientToken(payload.clientToken);
        if (payload.label || payload.clientToken) setAdvancedOpen(true);
        return;
      }
    }
    setServerUrl(value);
  }, []);

  const handleScanQr = React.useCallback(async () => {
    if (isScanning || isBusy) return;
    conn.setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          setServerUrl(result.url);
          if (result.label) setConnectionName(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          if (result.label || result.clientToken) setAdvancedOpen(true);
          await conn.connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          break;
        case 'permission-denied':
          conn.setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          conn.setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          conn.setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          conn.setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsScanning(false);
    }
  }, [conn, isBusy, isScanning, t]);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.submitPassword(password);
  }, [conn, password]);

  const cancelPassword = React.useCallback(() => {
    setPassword('');
    conn.cancelPassword();
  }, [conn]);

  return (
    <main className="oc-keyboard-fill-screen flex min-h-dvh flex-col overflow-y-auto bg-background px-6 pb-[calc(env(safe-area-inset-bottom)+28px)] pt-[calc(env(safe-area-inset-top)+28px)] text-foreground">
      <div className="m-auto flex w-full max-w-[360px] shrink-0 flex-col items-center gap-9 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <OpenChamberLogo width={72} height={72} className="size-[72px]" />
          <h1 className="typography-h2 text-foreground">{t('mobile.connect.welcome.title')}</h1>
        </div>

        {pendingConnection ? (
          <form className="flex w-full flex-col gap-3" onSubmit={handlePasswordSubmit}>
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0 text-left">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">{pendingConnection.url}</p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={cancelPassword}
            >
              {t('mobile.connect.cancelPassword')}
            </Button>
          </form>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <form className="flex w-full flex-col gap-3" onSubmit={handleSubmit}>
              <input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
              placeholder={t('mobile.instances.label.placeholder')}
              aria-label={t('mobile.instances.label.label')}
              autoComplete="off"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <input
              {...mobileInputKeyboardProps}
              value={serverUrl}
              onChange={(event) => handleUrlChange(event.target.value)}
              placeholder={t('mobile.connect.url.placeholder')}
              aria-label={t('mobile.connect.url.label')}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            />

              <div>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((value) => !value)}
                  aria-expanded={advancedOpen}
                  className="mx-auto flex items-center gap-1 rounded-full px-2 py-1 typography-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>{t('mobile.connect.advanced')}</span>
                  <Icon name="arrow-down-s" className={cn('size-4 transition-transform duration-200', advancedOpen && 'rotate-180')} />
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-200 ease-out"
                  style={{ gridTemplateRows: advancedOpen ? '1fr' : '0fr' }}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-1.5 pt-2 text-left">
                      <label className="block space-y-1.5">
                        <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.token.label')}</span>
                        <input
                          {...mobileInputKeyboardProps}
                          value={clientToken}
                          onChange={(event) => setClientToken(event.target.value)}
                          placeholder={t('mobile.connect.token.placeholder')}
                          tabIndex={advancedOpen ? undefined : -1}
                          autoCapitalize="none"
                          className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                        />
                      </label>
                      <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
                    </div>
                  </div>
                </div>
              </div>

              {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}

              <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isBusy || isScanning || !serverUrl.trim()}>
                {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
              </Button>
            </form>

            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="h-12 w-full"
              onClick={() => void handleScanQr()}
              disabled={!qrScanSupported || isScanning || isBusy}
            >
              <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
              {t('mobile.connect.scanQr')}
            </Button>
            {!qrScanSupported ? (
              <p className="px-1 text-center typography-micro text-muted-foreground">
                {t('mobile.connect.scan.unsupported')}
              </p>
            ) : null}
          </div>
        )}

        {!pendingConnection && connections.length > 0 ? (
          <section className="flex w-full flex-col gap-2.5">
            <h2 className="text-center typography-micro uppercase tracking-[0.14em] text-muted-foreground">
              {t('mobile.connect.saved.title')}
            </h2>
            <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
              {connections.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 border-b border-border/60 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                  onClick={() => void conn.connect({ url: connection.url, clientToken: connection.clientToken, label: connection.label })}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                    <Icon name="server" className="size-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                    <span className="block truncate typography-small text-muted-foreground">{connection.url}</span>
                  </span>
                  <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
};

const MobileInstancesSurface: React.FC<{
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ onActiveConnectionDeleted, onConnect }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnect);
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    connect, submitPassword, cancelPassword, saveConnection, removeConnection, setError,
  } = conn;
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingConnection = editingId ? connections.find((connection) => connection.id === editingId) ?? null : null;
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);

  // Populate/clear the form imperatively (on edit tap / cancel / save) rather than via
  // an effect keyed on the derived connection object. With an effect, any churn of the
  // connections list re-fires it and overwrites what the user is typing — the keyboard
  // "resets" mid-edit. Imperative population is immune to that.
  const resetForm = React.useCallback(() => {
    setEditingId(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setError(null);
  }, [setError]);

  const saveInstance = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void saveConnection({ url, label, clientToken }).then((saved) => {
      if (saved) resetForm();
    });
  }, [clientToken, label, resetForm, saveConnection, url]);

  // Scan a pairing QR into the add/edit form fields (does not change edit mode, so
  // the form-reset effect doesn't wipe the scanned values). The user reviews + saves.
  const handleScanInstance = React.useCallback(async () => {
    if (isScanning) return;
    setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          setUrl(result.url);
          if (result.label) setLabel(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          break;
        case 'permission-denied':
          setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsScanning(false);
    }
  }, [isScanning, setError, t]);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void submitPassword(password);
  }, [password, submitPassword]);

  const cancelPasswordPrompt = React.useCallback(() => {
    setPassword('');
    cancelPassword();
  }, [cancelPassword]);

  // Two-step delete (mirrors the session sheet): the trash icon arms the row, a
  // second tap on the destructive button confirms, the X disarms. No hover relied on.
  const toggleConfirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId((current) => (current === id ? null : id));
  }, []);

  const confirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId(null);
    if (editingId === id) resetForm();
    void removeConnection(id).then((removed) => {
      if (removed && isSameConnectionUrl(removed.url, getRuntimeApiBaseUrl())) {
        onActiveConnectionDeleted();
      }
    });
  }, [editingId, onActiveConnectionDeleted, removeConnection, resetForm]);

  const inputClass = 'h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20';

  if (pendingConnection) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <form className="flex-1 overflow-y-auto px-5 py-4" onSubmit={handlePasswordSubmit}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">{pendingConnection.url}</p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className={inputClass}
            />
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={cancelPasswordPrompt}>
              {t('mobile.connect.cancelPassword')}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-7">
          {connections.length > 0 ? (
            <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
              {connections.map((connection) => {
                const confirming = confirmingDeleteId === connection.id;
                return (
                  <div
                    key={connection.id}
                    className={cn(
                      'flex items-center border-b border-border/60 transition-colors last:border-b-0',
                      confirming && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-60"
                      onClick={() => void connect({ url: connection.url, clientToken: connection.clientToken, label: connection.label })}
                      disabled={isBusy || confirming}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                        <Icon name="server" className="size-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                        <span className="block truncate typography-small text-muted-foreground">{connection.url}</span>
                      </span>
                    </button>
                    <div className="flex items-center gap-0.5 pr-2">
                      {confirming ? (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.confirmDeleteAria', { label: connection.label })}
                          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 text-destructive-foreground transition-opacity active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                          onClick={() => confirmDelete(connection.id)}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="delete-bin" className="size-[18px]" />
                          <span className="typography-ui-label">{t('mobile.instances.delete')}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.edit')}
                          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => {
                            setEditingId(connection.id);
                            setUrl(connection.url);
                            setLabel(connection.label);
                            setClientToken(connection.clientToken || '');
                            setError(null);
                          }}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="edit" className="size-[18px]" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={confirming
                          ? t('mobile.instances.cancelDeleteAria', { label: connection.label })
                          : t('mobile.instances.deleteAria', { label: connection.label })}
                        className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => toggleConfirmDelete(connection.id)}
                        style={{ touchAction: 'manipulation' }}
                      >
                        <Icon name={confirming ? 'close' : 'delete-bin'} className="size-[18px]" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-[18px] border border-dashed border-border/70 px-4 py-6 text-center typography-small text-muted-foreground">
              {t('mobile.connect.saved.empty')}
            </p>
          )}

          <form className="space-y-3" onSubmit={saveInstance}>
            <div className="flex h-8 items-center justify-between gap-3 px-1">
              <h3 className="typography-ui-label text-foreground">
                {editingConnection ? t('mobile.instances.editTitle') : t('mobile.instances.addTitle')}
              </h3>
              {editingConnection ? (
                <Button type="button" variant="ghost" size="xs" onClick={resetForm}>
                  {t('mobile.instances.cancelEdit')}
                </Button>
              ) : null}
            </div>
            <div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 w-full"
                onClick={() => void handleScanInstance()}
                disabled={!qrScanSupported || isScanning}
              >
                <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                {t('mobile.connect.scanQr')}
              </Button>
              {!qrScanSupported ? (
                <p className="px-1 pt-1.5 typography-micro text-muted-foreground">{t('mobile.connect.scan.unsupported')}</p>
              ) : null}
            </div>
            <label className="block space-y-1.5">
              <span className="block px-1 typography-ui-label text-foreground">{t('mobile.instances.label.label')}</span>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('mobile.instances.label.placeholder')}
                autoComplete="off"
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.url.label')}</span>
              <input
                {...mobileInputKeyboardProps}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t('mobile.connect.url.placeholder')}
                type="url"
                inputMode="url"
                autoCapitalize="none"
                className={inputClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.token.label')}</span>
              <input
                {...mobileInputKeyboardProps}
                value={clientToken}
                onChange={(event) => setClientToken(event.target.value)}
                placeholder={t('mobile.connect.token.placeholder')}
                autoCapitalize="none"
                className={inputClass}
              />
              <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
            </label>
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full">
              {editingConnection ? t('mobile.instances.saveEdit') : t('mobile.instances.saveNew')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
};

type MobileUsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
  window: UsageWindow;
};

type MobileUsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  rows: MobileUsageLimitRow[];
  status: string | null;
};

const getWindowValueClass = (window: UsageWindow): string => {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 'text-foreground';
  if (usedPercent >= 80) return 'text-[var(--status-error)]';
  if (usedPercent >= 50) return 'text-[var(--status-warning)]';
  return 'text-foreground';
};

const ContextProgressIcon: React.FC<{ percentage: number }> = ({ percentage }) => {
  const progressPct = clampPercent(percentage) ?? 0;
  const tone = resolveUsageTone(percentage);
  const progressColor = tone === 'critical'
    ? 'var(--status-error)'
    : tone === 'warn'
      ? 'var(--status-warning)'
      : 'var(--status-success)';
  const size = 18;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="size-[18px] -rotate-90"
      role="progressbar"
      aria-valuenow={Math.round(progressPct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--interactive-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={progressColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progressPct / 100)}
        className="transition-[stroke-dashoffset,stroke] duration-300"
      />
    </svg>
  );
};

const MetadataRow: React.FC<{
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, iconNode, label, children }) => (
  <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5">
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {iconNode ?? (icon ? <Icon name={icon} className="size-[18px]" /> : null)}
    </span>
    <span className="shrink-0 typography-ui-label text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 truncate text-right typography-ui-label font-medium text-foreground">
      {children}
    </span>
  </div>
);

const SessionMetadataOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  contextDisplay: ContextDisplay;
  branchLabel: string;
  usageGroups: MobileUsageProviderGroup[];
  usageDisplayMode: 'usage' | 'remaining';
  isUsageLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ open, onClose, anchorRef, contextDisplay, branchLabel, usageGroups, usageDisplayMode, isUsageLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsExiting(false);
      return;
    }

    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;

    const closeIfOutside = (event: PointerEvent | WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    document.addEventListener('wheel', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      document.removeEventListener('wheel', closeIfOutside, true);
    };
  }, [anchorRef, onClose, open]);

  if (!shouldRender) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('mobile.header.openMetadataAria')}
        className={cn(
          'mx-3 mt-2 overflow-y-auto overscroll-contain rounded-[20px] border border-border/40 bg-[var(--surface-elevated)] p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.2)] will-change-transform',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-metadata-out' : 'session-metadata-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
        }}
      >
        <div className="space-y-1">
          <MetadataRow icon="git-branch" label={t('mobile.header.metadata.branch')}>
            {branchLabel}
          </MetadataRow>
          {contextDisplay ? (
            <MetadataRow
              iconNode={<ContextProgressIcon percentage={contextDisplay.percentage} />}
              label={t('mobile.header.metadata.context')}
            >
              <span className="inline-flex items-baseline gap-1.5 tabular-nums">
                <span className={cn('font-semibold', contextDisplay.colorClass)}>{contextDisplay.percentage.toFixed(1)}%</span>
                <span className="text-muted-foreground">{contextDisplay.tokens}</span>
              </span>
            </MetadataRow>
          ) : null}
          <MobileUsageLimits
            groups={usageGroups}
            displayMode={usageDisplayMode}
            isLoading={isUsageLoading}
            timeFormatPreference={timeFormatPreference}
          />
        </div>
      </div>
      <style>{`
        @keyframes session-metadata-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-metadata-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};

const MobileUsageLimits: React.FC<{
  groups: MobileUsageProviderGroup[];
  displayMode: 'usage' | 'remaining';
  isLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ groups, displayMode, isLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const modeLabel = displayMode === 'remaining' ? t('header.services.remaining') : t('header.services.used');

  if (groups.length === 0) return null;

  return (
    <div className="pt-2.5">
      <div className="flex min-w-0 items-center gap-3 px-2.5 pb-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon name="timer" className="size-[18px]" />
        </span>
        <span className="shrink-0 typography-ui-label text-muted-foreground">
          {t('mobile.header.metadata.usage')}
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center justify-end gap-1.5 typography-ui-label text-muted-foreground">
          {isLoading ? <Icon name="refresh" className="size-3.5 animate-spin" /> : null}
          <span className="truncate">{modeLabel}</span>
        </span>
      </div>

      <div className="space-y-1.5">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderLogo providerId={group.providerId} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
                {group.providerName}
              </span>
              {group.status && group.rows.length === 0 ? (
                <span className="shrink-0 truncate typography-micro text-muted-foreground">
                  {group.status}
                </span>
              ) : null}
            </div>
            {group.rows.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {group.rows.map((row) => {
                  const displayPercent = displayMode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
                  const metricLabel = formatQuotaValueLabel(row.window.valueLabel, displayPercent);
                  const resetLabel = formatQuotaResetLabel(
                    row.window.resetAt,
                    row.window.resetAfterFormatted ?? row.window.resetAtFormatted,
                    timeFormatPreference,
                  );
                  return (
                    <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="inline-flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate typography-ui-label text-muted-foreground">
                          {row.subtitle ? `${row.subtitle} · ${row.label}` : row.label}
                        </span>
                        {resetLabel ? (
                          <span className="shrink-0 truncate typography-micro text-muted-foreground/70">{resetLabel}</span>
                        ) : null}
                      </span>
                      <span className={cn('shrink-0 typography-ui-label font-semibold tabular-nums', getWindowValueClass(row.window))}>
                        {metricLabel === '-' ? '' : metricLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {group.status && group.rows.length > 0 ? (
              <div className="mt-1.5 typography-micro text-muted-foreground">{group.status}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const MobileOverflowMenu: React.FC<{
  open: boolean;
  onClose: () => void;
  items: OverflowItem[];
}> = ({ open, onClose, items }) => {
  const { t } = useI18n();
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t('mobile.menu.titleAria')}>
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={t('mobile.surface.closeAria')}
        onClick={onClose}
      />
      <div
        className="absolute right-2 top-[calc(var(--oc-safe-area-top,0px)+56px+4px)] w-[min(220px,calc(100vw-1rem))] origin-top-right overflow-hidden rounded-2xl border border-border/40 bg-background shadow-[0_18px_60px_rgb(0_0_0_/_0.35)]"
        role="menu"
        style={{ animation: 'mobile-menu-in 160ms cubic-bezier(0.32, 0.72, 0, 1)' }}
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
              index > 0 && 'border-t border-border/30',
            )}
            style={{ touchAction: 'manipulation' }}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.iconNode ?? (item.icon ? <Icon name={item.icon} className="size-5 shrink-0 text-muted-foreground" /> : null)}
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{item.label}</span>
            {item.badge && item.badge > 0 ? (
              <span className="inline-flex size-2 shrink-0 rounded-full bg-primary" aria-hidden />
            ) : null}
          </button>
        ))}
      </div>
      <style>{`@keyframes mobile-menu-in { from { opacity: 0; transform: translateY(-6px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }`}</style>
    </div>
  );
};

const MobileSessionMetadataButton = React.memo(function MobileSessionMetadataButton({
  open,
  onOpenChange,
  currentSessionId,
  effectiveDirectory,
  gitDirectory,
  isNewSessionDraftOpen,
  primaryLabel,
  secondaryLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  currentSessionId: string | null;
  effectiveDirectory: string | null;
  gitDirectory: string | null;
  isNewSessionDraftOpen: boolean;
  primaryLabel: string;
  secondaryLabel: string;
}) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const metadataTriggerRef = React.useRef<HTMLButtonElement>(null);
  const activeSessionMessages = useSessionMessages(currentSessionId ?? '', effectiveDirectory || undefined);
  const isGitRepo = useIsGitRepo(gitDirectory);
  const gitStatus = useGitStatus(gitDirectory);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  useConfigStore((state) => state.modelsMetadata.size);
  const savedSessionModel = useSelectionStore(
    React.useCallback(
      (state) => (currentSessionId ? state.sessionModelSelections.get(currentSessionId) ?? null : null),
      [currentSessionId],
    ),
  );
  const quotaResults = useQuotaStore((state) => state.results);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    if (!gitDirectory) return;
    void ensureStatus(gitDirectory, git);
  }, [ensureStatus, git, gitDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== gitDirectory) return;
      void fetchStatus(gitDirectory, git);
    });
  }, [fetchStatus, git, gitDirectory]);

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);

  React.useEffect(() => {
    preloadProviderLogos(dropdownProviderIds);
  }, [dropdownProviderIds]);

  React.useEffect(() => {
    if (!open || isQuotaLoading) return;
    const missingEnabledProvider = dropdownProviderIds.some((providerId) => (
      !quotaResults.some((result) => result.providerId === providerId)
    ));
    if (!missingEnabledProvider) return;
    void fetchAllQuotas();
  }, [dropdownProviderIds, fetchAllQuotas, isQuotaLoading, open, quotaResults]);

  const latestMessageModel = React.useMemo(() => {
    for (let i = activeSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = activeSessionMessages[i] as typeof activeSessionMessages[number] & {
        model?: { providerID?: string; modelID?: string };
      };
      if (message.role !== 'user') continue;
      const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined;
      const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined;
      if (providerID && modelID) return { providerID, modelID };
    }
    return null;
  }, [activeSessionMessages]);

  const modelRef = latestMessageModel
    ?? (savedSessionModel ? { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId } : null)
    ?? (currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null);
  const provider = modelRef ? providers.find((entry) => entry.id === modelRef.providerID) : undefined;
  const liveModel = provider?.models.find((model) => model.id === modelRef?.modelID);
  const metadata = modelRef ? getModelMetadata(modelRef.providerID, modelRef.modelID) : undefined;
  const contextLimit = getNumericLimit((liveModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? metadata?.limit?.context
    ?? 0;
  const totalTokens = React.useMemo(() => {
    for (let i = activeSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = activeSessionMessages[i] as typeof activeSessionMessages[number] & {
        tokens?: {
          input?: unknown;
          output?: unknown;
          reasoning?: unknown;
          cache?: { read?: unknown; write?: unknown };
        };
      };
      if (message.role !== 'assistant' || !message.tokens) continue;
      const total = getTokenCount(message.tokens.input)
        + getTokenCount(message.tokens.output)
        + getTokenCount(message.tokens.reasoning)
        + getTokenCount(message.tokens.cache?.read)
        + getTokenCount(message.tokens.cache?.write);
      if (total > 0) return total;
    }
    return 0;
  }, [activeSessionMessages]);

  const contextPercentage =
    !isNewSessionDraftOpen && totalTokens > 0 && contextLimit > 0
      ? Math.min((totalTokens / contextLimit) * 100, 999)
      : null;
  const contextTokens = contextPercentage !== null
    ? `${formatTokens(totalTokens)}/${formatTokens(contextLimit)}`
    : null;
  const contextColorClass =
    contextPercentage === null
      ? ''
      : contextPercentage >= 90
        ? 'text-[var(--status-error)]'
        : contextPercentage >= 75
          ? 'text-[var(--status-warning)]'
          : 'text-[var(--status-success)]';
  const contextDisplay: ContextDisplay = contextPercentage !== null && contextTokens
    ? { percentage: contextPercentage, tokens: contextTokens, colorClass: contextColorClass }
    : null;

  const branchLabel = isGitRepo === true
    ? (gitStatus?.current?.trim() || t('gitView.branch.detachedHead'))
    : t('common.unavailable');

  const usageGroups = React.useMemo<MobileUsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return QUOTA_PROVIDERS
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => resultsByProvider.get(providerMeta.id)?.configured === true)
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id)!;
        const rows: MobileUsageLimitRow[] = [];

        for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
          rows.push({
            key: `window-${label}`,
            label: formatWindowLabel(label),
            window,
          });
        }

        const modelEntries = Object.entries(result?.usage?.models ?? {});
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const [label, window] = entries[0];
          rows.push({
            key: `model-${modelName}-${label}`,
            label: formatWindowLabel(label),
            subtitle: getDisplayModelName(modelName),
            window,
          });
        }

        const status = !result.ok && result.error
          ? result.error
          : rows.length === 0
            ? t('header.services.noRateLimitsReported')
            : null;

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, quotaResults, selectedQuotaModels, t]);

  React.useEffect(() => {
    if (!open || usageGroups.length === 0) return;
    preloadProviderLogos(usageGroups.map((group) => group.providerId));
  }, [open, usageGroups]);

  return (
    <>
      <button
        ref={metadataTriggerRef}
        type="button"
        className="flex min-w-0 flex-1 items-center rounded-full px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={t('mobile.header.openMetadataAria')}
        aria-expanded={open}
        onClick={() => onOpenChange((currentOpen) => !currentOpen)}
        style={{ touchAction: 'manipulation' }}
      >
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="block truncate typography-ui-label text-foreground">{primaryLabel}</span>
          {secondaryLabel ? (
            <span className="block truncate typography-micro text-muted-foreground">{secondaryLabel}</span>
          ) : null}
        </span>
      </button>
      <SessionMetadataOverlay
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={metadataTriggerRef}
        contextDisplay={contextDisplay}
        branchLabel={branchLabel}
        usageGroups={usageGroups}
        usageDisplayMode={quotaDisplayMode}
        isUsageLoading={isQuotaLoading}
        timeFormatPreference={timeFormatPreference}
      />
    </>
  );
});

const MobileHeader: React.FC<{
  onOpenSessions: () => void;
  onOpenMenu: () => void;
}> = ({ onOpenSessions, onOpenMenu }) => {
  const { t } = useI18n();
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null), [currentSessionId]),
  );
  const effectiveDirectory = currentSessionDirectory || currentDirectory;
  const gitDirectory = normalizePath(effectiveDirectory) || null;
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const currentWorktreeMetadata = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.worktreeMetadata.get(currentSessionId) ?? null : null), [currentSessionId]),
  );
  const currentSession = useSession(currentSessionId, effectiveDirectory || undefined);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));

  const projectLabel = React.useMemo(() => {
    const directory = normalizePath(effectiveDirectory);
    if (!directory) return t('mobile.header.noProject');
    const metadataProject = currentWorktreeMetadata?.projectDirectory
      ? resolveProjectForDirectory(projects, currentWorktreeMetadata.projectDirectory)
      : null;
    const project = metadataProject ?? resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return getProjectDisplayLabel(project, directory) || t('mobile.header.noProject');
  }, [availableWorktreesByProject, currentWorktreeMetadata?.projectDirectory, effectiveDirectory, projects, t]);

  const sessionTitle = currentSession?.title?.trim();
  const primaryLabel = sessionTitle || (currentSessionId ? t('mobile.sessions.untitled') : projectLabel);
  const secondaryLabel = currentSessionId ? projectLabel : '';

  React.useEffect(() => {
    setMetadataOpen(false);
  }, [currentSessionId, effectiveDirectory]);

  const handleOpenSessions = React.useCallback(() => {
    setMetadataOpen(false);
    onOpenSessions();
  }, [onOpenSessions]);

  const handleOpenMenu = React.useCallback(() => {
    setMetadataOpen(false);
    onOpenMenu();
  }, [onOpenMenu]);

  return (
    <>
      <header
        className="relative z-30 flex shrink-0 items-center gap-1 border-b border-border/30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
      >
        <div className="flex h-[var(--oc-header-height,56px)] w-full items-center gap-1 px-2">
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.sessions.openSheetAria')}
            onClick={handleOpenSessions}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="menu" className="size-5" />
          </button>

          <MobileSessionMetadataButton
            open={metadataOpen}
            onOpenChange={setMetadataOpen}
            currentSessionId={currentSessionId}
            effectiveDirectory={effectiveDirectory}
            gitDirectory={gitDirectory}
            isNewSessionDraftOpen={isNewSessionDraftOpen}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />

          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.header.openMenuAria')}
            onClick={handleOpenMenu}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="more-2" className="size-5" />
          </button>
        </div>
      </header>
    </>
  );
};

const MobileShell: React.FC<{ onActiveConnectionDeleted: () => void }> = ({ onActiveConnectionDeleted }) => {
  const { t } = useI18n();
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [changesOpen, setChangesOpen] = React.useState(false);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [instancesOpen, setInstancesOpen] = React.useState(false);
  const [isMcpRefreshing, setIsMcpRefreshing] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [updateOpen, setUpdateOpen] = React.useState(false);
  const [settingsInitialMobileStage, setSettingsInitialMobileStage] = React.useState<'nav' | 'page-content'>('nav');
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  // When set, the Changes surface opens directly into the per-file diff for this path.
  const [pendingChangesDiff, setPendingChangesDiff] = React.useState<{ path: string; staged: boolean } | null>(null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const updateAvailable = useUpdateStore((state) => state.available);
  const updateRuntimeType = useUpdateStore((state) => state.runtimeType);
  const showCapacitorOnlyFeatures = React.useMemo(() => isCapacitorMobileApp(), []);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const setMcpDraft = useMcpConfigStore((state) => state.setMcpDraft);
  const setSelectedMcp = useMcpConfigStore((state) => state.setSelectedMcp);
  const refreshMcpStatus = useMcpStore((state) => state.refresh);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const gitStatus = useGitStatus(normalizePath(currentDirectory) || null);
  const dirtyChangeCount = gitStatus?.files?.length ?? 0;

  const mobileActions = React.useMemo<MobileAppActions>(
    () => ({
      openChanges: ({ diffPath, staged } = {}) => {
        setPendingChangesDiff(diffPath ? { path: diffPath, staged: staged === true } : null);
        setChangesOpen(true);
      },
      openFiles: () => setFilesOpen(true),
      openSettings: () => {
        setSettingsInitialMobileStage('nav');
        setSettingsOpen(true);
      },
    }),
    [],
  );

  const closeChanges = React.useCallback(() => {
    setChangesOpen(false);
    setPendingChangesDiff(null);
  }, []);

  const handleNativeBack = React.useCallback(() => {
    if (overflowOpen) {
      setOverflowOpen(false);
      return true;
    }
    if (sessionsSheetOpen) {
      setSessionsSheetOpen(false);
      return true;
    }
    if (filesOpen) {
      setFilesOpen(false);
      return true;
    }
    if (changesOpen) {
      closeChanges();
      return true;
    }
    if (mcpOpen) {
      setMcpOpen(false);
      return true;
    }
    if (instancesOpen) {
      setInstancesOpen(false);
      return true;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return true;
    }
    if (updateOpen) {
      setUpdateOpen(false);
      return true;
    }
    return false;
  }, [changesOpen, closeChanges, filesOpen, instancesOpen, mcpOpen, overflowOpen, sessionsSheetOpen, settingsOpen, updateOpen]);

  useNativeAndroidBackButton(handleNativeBack);

  const showUpdateItem = updateAvailable && (updateRuntimeType === 'desktop' || updateRuntimeType === 'web');

  const openMcpCreateSettings = React.useCallback(() => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((server) => server.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter += 1;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      oauthEnabled: true,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
      timeout: '',
      enabled: true,
    };

    setMcpDraft(draft);
    setSelectedMcp(newName);
    setSettingsPage('mcp');
    setMcpOpen(false);
    setSettingsInitialMobileStage('page-content');
    setSettingsOpen(true);
  }, [mcpServers, setMcpDraft, setSelectedMcp, setSettingsPage]);

  const refreshMcpOverlay = React.useCallback(() => {
    if (isMcpRefreshing) return;
    setIsMcpRefreshing(true);
    const directory = currentDirectory || null;
    const minSpinPromise = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([
      refreshMcpStatus({ directory, silent: true }),
      loadMcpConfigs({ force: true }),
      minSpinPromise,
    ]).finally(() => setIsMcpRefreshing(false));
  }, [currentDirectory, isMcpRefreshing, loadMcpConfigs, refreshMcpStatus]);

  const overflowItems: OverflowItem[] = React.useMemo(
    () => {
      const items: OverflowItem[] = [
      {
        key: 'files',
        icon: 'file-text',
        label: t('mobile.menu.files'),
        onSelect: () => setFilesOpen(true),
      },
      {
        key: 'changes',
        icon: 'git-branch',
        label: t('mobile.menu.changes'),
        badge: dirtyChangeCount,
        onSelect: () => setChangesOpen(true),
      },
      {
        key: 'mcp',
        iconNode: <McpIcon className="size-5 shrink-0 text-muted-foreground" />,
        label: t('mobile.menu.mcp'),
        onSelect: () => setMcpOpen(true),
      },
      ];
      if (showCapacitorOnlyFeatures) {
        items.push({
          key: 'instances',
          icon: 'server',
          label: t('mobile.menu.instances'),
          onSelect: () => setInstancesOpen(true),
        });
      }
      if (showUpdateItem) {
        items.push({
          key: 'update',
          icon: 'download',
          label: t('mobile.menu.update'),
          onSelect: () => setUpdateOpen(true),
        });
      }
      items.push({
        key: 'settings',
        icon: 'settings-3',
        label: t('mobile.menu.settings'),
        onSelect: () => {
          setSettingsInitialMobileStage('nav');
          setSettingsOpen(true);
        },
      });
      return items;
    },
    [dirtyChangeCount, showCapacitorOnlyFeatures, showUpdateItem, t],
  );

  return (
    <DedicatedMobileAppProvider actions={mobileActions}>
      <div
        className="oc-mobile-app-shell main-content-safe-area flex h-[100dvh] flex-col bg-background text-foreground"
        data-page-scroll-lock="true"
      >
        <MobileHeader
          onOpenSessions={() => setSessionsSheetOpen(true)}
          onOpenMenu={() => setOverflowOpen(true)}
        />
        <main className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
          <ErrorBoundary>
            <ChatView />
          </ErrorBoundary>
        </main>

        <MobileOverflowMenu
          open={overflowOpen}
          onClose={() => setOverflowOpen(false)}
          items={overflowItems}
        />

        {sessionsSheetOpen ? (
          <MobileSessionsSheet open={sessionsSheetOpen} onOpenChange={setSessionsSheetOpen} />
        ) : null}

        {/* Mounted only while open (like the sessions sheet) so each surface
            computes its safe-area / fixed-position layout fresh on open. Keeping
            them always-mounted left a stale startup layout, which made the
            top-inset dimming appear only intermittently on iOS. */}
        {filesOpen ? (
          <MobileSurfaceShell
            open
            onClose={() => setFilesOpen(false)}
            ariaLabel={t('mobile.menu.files')}
            headerless
          >
            <ErrorBoundary>
              <MobileFilesSurface onClose={() => setFilesOpen(false)} />
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}

        {changesOpen ? (
          <MobileSurfaceShell
            open
            onClose={closeChanges}
            ariaLabel={t('mobile.menu.changes')}
            headerless
          >
            <ErrorBoundary>
              <MobileChangesSurface
                onClose={closeChanges}
                initialDiffPath={pendingChangesDiff?.path ?? null}
                initialDiffStaged={pendingChangesDiff?.staged === true}
              />
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}

        {mcpOpen ? (
          <MobileOverlayPanel
            open
            onClose={() => setMcpOpen(false)}
            title={t('mcpDropdown.title')}
            className="h-[72vh]"
            contentMaxHeightClassName="max-h-full"
            renderHeader={(closeButton) => (
              <div className="shrink-0">
                <div className="flex justify-center pt-2.5 pb-1">
                  <div className="h-1 w-9 rounded-full bg-[color-mix(in_srgb,var(--surface-mutedForeground)_40%,transparent)]" />
                </div>
                <div className="flex items-center justify-between gap-2 px-4 pb-2">
                  <h2 className="text-[16px] font-semibold text-[var(--surface-foreground)]">
                    {t('mcpDropdown.title')}
                  </h2>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
                      onClick={openMcpCreateSettings}
                      aria-label={t('settings.mcp.sidebar.actions.addServerTitle')}
                      title={t('settings.mcp.sidebar.actions.addServerTitle')}
                      style={{ touchAction: 'manipulation' }}
                    >
                      <Icon name="add" className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] disabled:opacity-60"
                      onClick={refreshMcpOverlay}
                      disabled={isMcpRefreshing}
                      aria-label={t('mcpDropdown.actions.refreshAria')}
                      title={t('mcpDropdown.actions.refreshAria')}
                      style={{ touchAction: 'manipulation' }}
                    >
                      <Icon name="refresh" className={cn('h-5 w-5', isMcpRefreshing && 'animate-spin')} />
                    </button>
                    {closeButton}
                  </div>
                </div>
              </div>
            )}
          >
            <ErrorBoundary>
              <McpDropdownContent
                active
                className="h-full"
                listClassName="max-h-none"
                hideHeader
                mobileListDensity
              />
            </ErrorBoundary>
          </MobileOverlayPanel>
        ) : null}

        {instancesOpen && showCapacitorOnlyFeatures ? (
          <MobileSurfaceShell
            open
            onClose={() => setInstancesOpen(false)}
            ariaLabel={t('mobile.menu.instances')}
            title={t('mobile.menu.instances')}
          >
            <MobileInstancesSurface
              onConnect={() => setInstancesOpen(false)}
              onActiveConnectionDeleted={onActiveConnectionDeleted}
            />
          </MobileSurfaceShell>
        ) : null}

        {settingsOpen ? (
          <MobileSurfaceShell
            open
            onClose={() => setSettingsOpen(false)}
            ariaLabel={t('mobile.menu.settings')}
            headerless
          >
            <ErrorBoundary>
              <SettingsView
                forceMobile
                isWindowed
                initialMobileStage={settingsInitialMobileStage}
                visiblePageSlugs={[...MOBILE_SETTINGS_PAGES]}
                onClose={() => setSettingsOpen(false)}
              />
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}

        {updateOpen ? (
          <MobileSurfaceShell
            open
            onClose={() => setUpdateOpen(false)}
            ariaLabel={t('mobile.menu.update')}
            title={t('mobile.menu.update')}
          >
            <ErrorBoundary>
              <div className="h-full overflow-auto px-5 py-4">
                <AboutSettings initialUpdateDialogOpen />
              </div>
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}
      </div>
    </DedicatedMobileAppProvider>
  );
};

export function MobileApp({ apis }: MobileAppProps) {
  const { t } = useI18n();
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);

  const handleNativeResume = React.useCallback(() => {
    if (!getRuntimeApiBaseUrl()) return;
    void initializeApp();
    void refreshGitHubAuthStatus(apis.github, { force: true });
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:nativeResume' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:nativeResume' });
  }, [agentsCount, apis.github, initializeApp, loadAgents, loadProviders, providersCount, refreshGitHubAuthStatus]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // stores still hold the previous instance's data. Mirror the web App.tsx reset
  // sequence so the UI fully re-bootstraps against the new server instead of going
  // stale. The SyncProvider is keyed by runtimeEndpointEpoch so it remounts too.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    void initializeApp();
  }, [connectionEpoch, initializeApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  // Discover all worktrees for every known project so the draft session's
  // worktree/branch dropdown can list every available branch — not only the
  // current one. Mirrors ElectronMiniChatApp + desktop SessionSidebar.
  React.useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;

    const run = async () => {
      const worktreesByProject = new Map<string, WorktreeMetadata[]>();
      const allWorktrees: WorktreeMetadata[] = [];

      await Promise.all(
        projects.map(async (project) => {
          const projectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
          if (!projectPath) return;
          try {
            const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
            const isGitRepo =
              cachedIsGitRepo ?? (await import('@/lib/gitApi').then((m) => m.checkIsGitRepository(projectPath)));
            if (!isGitRepo) return;
            const worktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
            if (cancelled || worktrees.length === 0) return;
            worktreesByProject.set(projectPath, worktrees);
            allWorktrees.push(...worktrees);
          } catch {
            // Worktree discovery is best-effort; draft selector falls back to the project root.
          }
        }),
      );

      if (cancelled) return;
      useSessionUIStore.setState({
        availableWorktrees: allWorktrees,
        availableWorktreesByProject: worktreesByProject,
      });
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [projects]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | { planModeExperimentalEnabled?: unknown };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      setPlanModeEnabled(raw === true || raw === 1 || raw === '1' || raw === 'true');
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    if (!isNativeMobileApp || isConnected || !getRuntimeApiBaseUrl()) {
      setShowConnectionRecovery(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowConnectionRecovery(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useUpdatePolling();
  useWindowTitle();
  useRouter();
  const fontsReady = useFontsReady();

  // `isConnected` is a LIVE flag that flips false on every transient SSE/WS drop and
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // While 'reconnecting' (we were connected before), keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <OpenChamberLogo width={96} height={96} isAnimated />
      </main>
    );
  }

  if (!isConnected && !isReconnecting && isNativeMobileApp) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (getRuntimeApiBaseUrl()) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <OpenChamberLogo width={96} height={96} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
                  <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                    setConnectionEpoch((value) => value + 1);
                  }}
                >
                  {t('mobile.connect.cancelPassword')}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    return <MobileConnectionWelcome onConnected={() => setConnectionEpoch((value) => value + 1)} />;
  }

  if (!isConnected && !isReconnecting) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
          <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized} />
              <OpenCodeUpdateToast />
              <MobileShell onActiveConnectionDeleted={() => {
                switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                setConnectionEpoch((value) => value + 1);
              }} />
              <Toaster />
              {isInitialized ? <ConfigUpdateOverlay /> : null}
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
