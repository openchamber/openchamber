import React from 'react';
import { isDesktopShell, isTauriShell, startDesktopWindowDrag } from '@/lib/desktop';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { updateDesktopSettings } from '@/lib/persistence';
import { copyTextToClipboard } from '@/lib/clipboard';
import { restartDesktopApp } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { RemoteConnectionForm } from './RemoteConnectionForm';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';

const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';
const DOCS_URL = 'https://opencode.ai/docs';
const WINDOWS_WSL_DOCS_URL = 'https://opencode.ai/docs/windows-wsl';
const POLL_INTERVAL_MS = 2500;

type OnboardingPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

type ChooserScreenProps = {
  /** Callback when CLI becomes available */
  onCliAvailable?: () => void;
};

function BashCommand({ onCopy, copyTitle }: { onCopy: () => void; copyTitle: string }) {
  return (
    <div className="flex items-center justify-between gap-3 w-full">
      <code className="flex-1 text-left overflow-x-auto whitespace-nowrap">
        <span style={{ color: 'var(--syntax-keyword)' }}>curl</span>
        <span className="text-muted-foreground"> -fsSL </span>
        <span style={{ color: 'var(--syntax-string)' }}>https://opencode.ai/install</span>
        <span className="text-muted-foreground"> | </span>
        <span style={{ color: 'var(--syntax-keyword)' }}>bash</span>
      </code>
      <button
        onClick={onCopy}
        className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
        title={copyTitle}
        aria-label={copyTitle}
      >
        <Icon name="file-copy" className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ChooserScreen({ onCliAvailable }: ChooserScreenProps) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [isApplyingPath, setIsApplyingPath] = React.useState(false);
  const [isManualChecking, setIsManualChecking] = React.useState(false);
  const [opencodeBinary, setOpencodeBinary] = React.useState('');
  const [platform, setPlatform] = React.useState<OnboardingPlatform>('unknown');
  const [activeTab, setActiveTab] = React.useState<'local' | 'remote'>('local');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [troubleOpen, setTroubleOpen] = React.useState(false);

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  React.useEffect(() => {
    if (typeof navigator === 'undefined') {
      setPlatform('unknown');
      return;
    }

    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) setPlatform('windows');
    else if (/Macintosh|Mac OS X/i.test(ua)) setPlatform('macos');
    else if (/Linux/i.test(ua)) setPlatform('linux');
    else setPlatform('unknown');
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/config/settings', { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = (await response.json().catch(() => null)) as null | { opencodeBinary?: unknown };
        if (!data || cancelled) return;
        const value = typeof data.opencodeBinary === 'string' ? data.opencodeBinary.trim() : '';
        if (value) setOpencodeBinary(value);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) return;
    if (target.closest('button, a, input, select, textarea, code, summary, details')) return;
    if (e.button !== 0) return;
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const checkCliAvailability = React.useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/health');
      if (!response.ok) return false;
      const data = await response.json();
      return data.openCodeRunning === true || data.isOpenCodeReady === true;
    } catch {
      return false;
    }
  }, []);

  const persistFirstChoice = React.useCallback(async (choice: 'local' | 'remote') => {
    if (!isTauriShell()) return;

    const config = await desktopHostsGet();
    await desktopHostsSet({
      ...config,
      ...(choice === 'local' ? { defaultHostId: 'local' } : {}),
      initialHostChoiceCompleted: true,
    });
  }, []);

  const announceAvailable = React.useCallback(async () => {
    if (isTauriShell()) {
      await persistFirstChoice('local');
    }
    onCliAvailable?.();
  }, [onCliAvailable, persistFirstChoice]);

  // Background polling: while the local tab is visible, periodically check
  // whether the OpenCode CLI is reachable. As soon as it is, transition
  // automatically — the user doesn't have to click anything.
  React.useEffect(() => {
    if (activeTab !== 'local') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const available = await checkCliAvailability();
        if (cancelled) return;
        if (available) {
          await announceAvailable();
          return;
        }
      } catch {
        // ignore
      }
      if (!cancelled) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeTab, checkCliAvailability, announceAvailable]);

  const handleManualCheck = React.useCallback(async () => {
    setIsManualChecking(true);
    try {
      const available = await checkCliAvailability();
      if (available) await announceAvailable();
    } finally {
      setIsManualChecking(false);
    }
  }, [checkCliAvailability, announceAvailable]);

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!isDesktopApp || !isTauriShell()) return;

    const tauri = (window as unknown as { __TAURI__?: { dialog?: { open?: (opts: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
    if (!tauri?.dialog?.open) return;

    try {
      const selected = await tauri.dialog.open({
        title: t('onboarding.localSetup.dialog.selectOpencodeBinary'),
        multiple: false,
        directory: false,
      });
      if (typeof selected === 'string' && selected.trim().length > 0) {
        setOpencodeBinary(selected.trim());
      }
    } catch {
      // ignore
    }
  }, [isDesktopApp, t]);

  const handleApplyPath = React.useCallback(async () => {
    setIsApplyingPath(true);
    try {
      await updateDesktopSettings({ opencodeBinary: opencodeBinary.trim() });
      if (isTauriShell()) {
        await persistFirstChoice('local');
        await restartDesktopApp();
        return;
      }
      await fetch('/api/config/reload', { method: 'POST' });
    } finally {
      setTimeout(() => setIsApplyingPath(false), 1000);
    }
  }, [opencodeBinary, persistFirstChoice]);

  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(INSTALL_COMMAND);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy:', result.error);
    }
  }, []);

  const docsUrl = platform === 'windows' ? WINDOWS_WSL_DOCS_URL : DOCS_URL;
  const binaryPlaceholder =
    platform === 'windows'
      ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
      : platform === 'linux'
        ? '/home/you/.bun/bin/opencode'
        : '/Users/you/.bun/bin/opencode';

  const showLocal = !isDesktopApp || !isTauriShell() || activeTab === 'local';

  return (
    <div
      className="app-region-drag h-full flex items-center justify-center bg-transparent p-8 cursor-default select-none overflow-y-auto"
      onMouseDown={handleDragStart}
    >
      <div className="w-full max-w-md space-y-7">
        <header className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('onboarding.chooser.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('onboarding.chooser.description')}
          </p>
        </header>

        {isDesktopApp && isTauriShell() && (
          <div className="app-region-no-drag flex gap-1.5">
            <button
              type="button"
              className={cn(
                'flex-1 px-4 py-2 rounded-lg border transition-colors text-sm',
                activeTab === 'local'
                  ? 'border-[var(--interactive-selection)] text-foreground bg-[var(--interactive-selection)]/10'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground'
              )}
              onClick={() => setActiveTab('local')}
            >
              {t('onboarding.chooser.tabs.localInstall')}
            </button>
            <button
              type="button"
              className={cn(
                'flex-1 px-4 py-2 rounded-lg border transition-colors text-sm',
                activeTab === 'remote'
                  ? 'border-[var(--interactive-selection)] text-foreground bg-[var(--interactive-selection)]/10'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground'
              )}
              onClick={() => setActiveTab('remote')}
            >
              {t('onboarding.chooser.tabs.connectRemote')}
            </button>
          </div>
        )}

        {isDesktopApp && isTauriShell() && activeTab === 'remote' ? (
          <div className="app-region-no-drag">
            <RemoteConnectionForm
              onBack={() => setActiveTab('local')}
              showBackButton={false}
              onSwitchToLocal={() => setActiveTab('local')}
            />
          </div>
        ) : null}

        {showLocal && (
          <div className="space-y-4">
            {platform === 'windows' && (
              <div className="rounded-lg border border-border bg-background/50 p-4">
                <div className="text-sm text-foreground">{t('onboarding.localSetup.windows.title')}</div>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  <li>{t('onboarding.localSetup.windows.stepInstallWsl')} <code className="text-foreground/80">wsl --install</code> {t('onboarding.localSetup.windows.stepInstallWslSuffix')}</li>
                  <li>{t('onboarding.localSetup.windows.stepRunInstallInWsl')}</li>
                  <li>{t('onboarding.localSetup.windows.stepSetBinaryPath')}</li>
                </ol>
              </div>
            )}

            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('onboarding.localSetup.intro')}
            </p>

            <div className="app-region-no-drag rounded-lg border border-border bg-background/60 backdrop-blur-sm px-4 py-3 font-mono text-sm">
              {copied ? (
                <div className="flex items-center gap-2" style={{ color: 'var(--status-success)' }}>
                  <Icon name="check" className="h-4 w-4" />
                  {t('onboarding.common.status.copiedToClipboard')}
                </div>
              ) : (
                <BashCommand onCopy={handleCopy} copyTitle={t('onboarding.common.copyToClipboard')} />
              )}
            </div>

            <div className="app-region-no-drag flex items-center justify-between">
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
              >
                {platform === 'windows' ? t('onboarding.localSetup.docs.windows') : t('onboarding.localSetup.docs.default')}
                <Icon name="external-link" className="h-3 w-3" />
              </a>
              <button
                type="button"
                onClick={handleManualCheck}
                disabled={isManualChecking}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {isManualChecking ? t('onboarding.localSetup.actions.checking') : t('onboarding.localSetup.actions.checkNow')}
              </button>
            </div>

            <div
              className="rounded-lg border px-4 py-3 flex items-center gap-3"
              style={{
                borderColor: 'color-mix(in srgb, var(--primary-base) 20%, transparent)',
                backgroundColor: 'color-mix(in srgb, var(--primary-base) 6%, transparent)',
              }}
              role="status"
              aria-live="polite"
            >
              <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden>
                <span
                  className="absolute inset-0 rounded-full"
                  style={{
                    backgroundColor: 'var(--primary-base)',
                    animation: 'pulse-opacity 1.6s ease-in-out infinite',
                  }}
                />
                <span
                  className="absolute inset-[-4px] rounded-full"
                  style={{
                    backgroundColor: 'var(--primary-base)',
                    animation: 'pulse-opacity-dim 1.6s ease-in-out infinite',
                    opacity: 0,
                  }}
                />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground leading-tight">
                  {t('onboarding.localSetup.status.watching')}
                </div>
                <div className="text-xs text-muted-foreground leading-tight mt-0.5">
                  {t('onboarding.localSetup.status.autoContinue')}
                </div>
              </div>
            </div>

            <details
              className="app-region-no-drag group rounded-lg border border-border/60 px-4 open:bg-background/40 transition-colors"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="flex items-center justify-between cursor-pointer py-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors list-none [&::-webkit-details-marker]:hidden">
                <span>{t('onboarding.localSetup.advanced.title')}</span>
                <Icon name="arrow-down-s" className="h-4 w-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="pb-4 space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={opencodeBinary}
                    onChange={(e) => setOpencodeBinary(e.target.value)}
                    placeholder={binaryPlaceholder}
                    disabled={isApplyingPath}
                    className="flex-1 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleBrowse}
                    disabled={isApplyingPath || !isDesktopApp || !isTauriShell()}
                  >
                    {t('onboarding.localSetup.actions.browse')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleApplyPath}
                    disabled={isApplyingPath || !opencodeBinary.trim()}
                  >
                    {t('onboarding.localSetup.actions.apply')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground/70">
                  {t('onboarding.localSetup.helper.saveAndReload')}
                </p>
              </div>
            </details>

            <details
              className="app-region-no-drag group rounded-lg border border-border/60 px-4 open:bg-background/40 transition-colors"
              open={troubleOpen}
              onToggle={(e) => setTroubleOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="flex items-center justify-between cursor-pointer py-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors list-none [&::-webkit-details-marker]:hidden">
                <span>{t('onboarding.localSetup.troubleshoot.title')}</span>
                <Icon name="arrow-down-s" className="h-4 w-4 transition-transform group-open:rotate-180" />
              </summary>
              <ul className="pb-4 space-y-1.5 text-xs text-muted-foreground list-disc pl-4">
                {platform === 'windows' ? (
                  <>
                    <li>{t('onboarding.localSetup.windows.hintInstallInWsl')}</li>
                    <li>{t('onboarding.localSetup.windows.hintDetectionFailed')}</li>
                  </>
                ) : (
                  <>
                    <li>{t('onboarding.localSetup.hint.ensurePath')}</li>
                    <li>{t('onboarding.localSetup.hint.setEnv')}</li>
                    <li>{t('onboarding.localSetup.hint.missingRuntime')}</li>
                  </>
                )}
              </ul>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
