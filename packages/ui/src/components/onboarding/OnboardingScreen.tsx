import React from 'react';
import { RiFileCopyLine, RiCheckLine, RiExternalLinkLine } from '@remixicon/react';
import { isDesktopShell, isTauriShell } from '@/lib/desktop';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updateDesktopSettings } from '@/lib/persistence';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useLanguage } from '@/hooks/useLanguage';

const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';
const POLL_INTERVAL_MS = 3000;
const DOCS_URL = 'https://opencode.ai/docs';
const WINDOWS_WSL_DOCS_URL = 'https://opencode.ai/docs/windows-wsl';

type OnboardingPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

type OnboardingScreenProps = {
  onCliAvailable?: () => void;
};

function BashCommand({ onCopy, copyTitle }: { onCopy: () => void; copyTitle: string }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <code>
        <span style={{ color: 'var(--syntax-keyword)' }}>curl</span> {/* // i18n-scan-ignore */}
        <span className="text-muted-foreground"> -fsSL </span> {/* // i18n-scan-ignore */}
        <span style={{ color: 'var(--syntax-string)' }}>https://opencode.ai/install</span>
        <span className="text-muted-foreground"> | </span>
        <span style={{ color: 'var(--syntax-keyword)' }}>bash</span> {/* // i18n-scan-ignore */}
      </code>
      <button
        onClick={onCopy}
        className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
        title={copyTitle}
      >
        <RiFileCopyLine className="h-4 w-4" />
      </button>
    </div>
  );
}

const HINT_DELAY_MS = 30000;

export function OnboardingScreen({ onCliAvailable }: OnboardingScreenProps) {
  const { t } = useLanguage();
  const [copied, setCopied] = React.useState(false);
  const [showHint, setShowHint] = React.useState(false);
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [opencodeBinary, setOpencodeBinary] = React.useState('');
  const [platform, setPlatform] = React.useState<OnboardingPlatform>('unknown');

  React.useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  React.useEffect(() => {
    if (typeof navigator === 'undefined') {
      setPlatform('unknown');
      return;
    }

    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) {
      setPlatform('windows');
      return;
    }
    if (/Macintosh|Mac OS X/i.test(ua)) {
      setPlatform('macos');
      return;
    }
    if (/Linux/i.test(ua)) {
      setPlatform('linux');
      return;
    }
    setPlatform('unknown');
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
        if (value) {
          setOpencodeBinary(value);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, code')) {
      return;
    }
    if (e.button !== 0) return;
    if (isDesktopApp && isTauriShell()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        await window.startDragging();
      } catch (error) {
        console.error('Failed to start window dragging:', error);
      }
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

  const handleRetry = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      await fetch('/api/config/reload', { method: 'POST' });
    } finally {
      setTimeout(() => setIsRetrying(false), 1000);
    }
  }, []);

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!isDesktopApp || !isTauriShell()) {
      return;
    }

    const tauri = (window as unknown as { __TAURI__?: { dialog?: { open?: (opts: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
    if (!tauri?.dialog?.open) {
      return;
    }

    try {
      const selected = await tauri.dialog.open({
        title: t('openCodeCliSettings.selectOpencodeBinary'),
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
    setIsRetrying(true);
    try {
      await updateDesktopSettings({ opencodeBinary: opencodeBinary.trim() });
      await fetch('/api/config/reload', { method: 'POST' });
    } finally {
      setTimeout(() => setIsRetrying(false), 1000);
    }
  }, [opencodeBinary]);

  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(INSTALL_COMMAND);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy:', result.error);
    }
  }, []);

  React.useEffect(() => {
    const poll = async () => {
      const available = await checkCliAvailability();
      if (available) {
        onCliAvailable?.();
      }
    };

    const interval = setInterval(poll, POLL_INTERVAL_MS);
    poll();

    return () => clearInterval(interval);
  }, [checkCliAvailability, onCliAvailable]);

  const docsUrl = platform === 'windows' ? WINDOWS_WSL_DOCS_URL : DOCS_URL;
  const binaryPlaceholder =
    platform === 'windows'
      ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd'
      : platform === 'linux'
        ? '/home/you/.bun/bin/opencode'
        : '/Users/you/.bun/bin/opencode';

  return (
    <div
      className="h-full flex items-center justify-center bg-transparent p-8 relative cursor-default select-none"
      onMouseDown={handleDragStart}
    >
      <div className="w-full space-y-4 text-center">
        <div className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {t('onboarding.welcomeToOpenChamber')}
          </h1>
          <p className="text-muted-foreground">
            <a
              href="https://opencode.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              OpenCode CLI
              <RiExternalLinkLine className="h-4 w-4" />
            </a>
            {' '}is required to continue.
          </p>
        </div>

        {platform === 'windows' && (
          <div className="mx-auto max-w-2xl rounded-lg border border-border bg-background/50 p-4 text-left">
            <div className="text-sm text-foreground">{t('onboarding.windowsSetupTitle')}</div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('onboarding.installWslPrefix')} <code className="text-foreground/80">wsl --install</code> {/* // i18n-scan-ignore */} {t('onboarding.installWslSuffix')}</li>
              <li>{t('onboarding.runInstallCommandInWsl')}</li>
              <li>{t('onboarding.setBinaryPathIfNotDetected')}</li>
            </ol>
          </div>
        )}

        <div className="flex justify-center">
          <div className="bg-background/60 backdrop-blur-sm border border-border rounded-lg px-5 py-3 font-mono text-sm w-fit">
            {copied ? (
              <div className="flex items-center justify-center gap-2" style={{ color: 'var(--status-success)' }}>
                <RiCheckLine className="h-4 w-4" />
                Copied to clipboard
              </div>
            ) : (
              <BashCommand onCopy={handleCopy} copyTitle={t('onboarding.copyToClipboard')} />
            )}
          </div>
        </div>

        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1 justify-center"
        >
          {platform === 'windows' ? t('onboarding.viewWindowsWslDocumentation') : t('onboarding.viewDocumentation')}
          <RiExternalLinkLine className="h-3 w-3" />
        </a>

        <p className="text-sm text-muted-foreground animate-pulse">
          {t('onboarding.waitingForOpenCodeInstallation')}
        </p>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {isRetrying ? t('onboarding.retrying') : t('common.retry')}
          </button>
        </div>

        <div className="mx-auto w-full max-w-xl pt-4">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">{t('onboarding.alreadyInstalledSetCliPath')}</div>
            <div className="flex gap-2">
              <Input
                value={opencodeBinary}
                onChange={(e) => setOpencodeBinary(e.target.value)}
                placeholder={binaryPlaceholder}
                disabled={isRetrying}
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleBrowse}
                disabled={isRetrying || !isDesktopApp || !isTauriShell()}
              >
                {t('openCodeCliSettings.browse')}
              </Button>
              <Button
                type="button"
                onClick={handleApplyPath}
                disabled={isRetrying}
              >
                {t('onboarding.apply')}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground/70">{t('onboarding.savesAndReloadsConfig')}</div>
          </div>
        </div>
      </div>

      {showHint && (
        <div className="absolute bottom-8 left-0 right-0 text-center space-y-1">
          {platform === 'windows' ? (
            <>
              <p className="text-sm text-muted-foreground/70">
                {t('onboarding.windowsInstallAndRunInWslForBestCompatibility')}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {t('onboarding.windowsHintPathPrefix')} (<code className="text-foreground/70">opencode.cmd</code>/<code className="text-foreground/70">opencode.exe</code> {/* // i18n-scan-ignore */}), <code className="text-foreground/70">wsl.exe</code> {/* // i18n-scan-ignore */}, {t('onboarding.windowsHintOr')} <code className="text-foreground/70">wsl:/usr/local/bin/opencode</code> {/* // i18n-scan-ignore */}.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground/70">
                {t('onboarding.ensureOpencodeInPathPrefix')} <code className="text-foreground/70">opencode</code> {/* // i18n-scan-ignore */} {t('onboarding.ensureOpencodeInPathSuffix')}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {t('onboarding.orSetEnvVarPrefix')} <code className="text-foreground/70">OPENCODE_BINARY</code> {/* // i18n-scan-ignore */} {t('onboarding.orSetEnvVarSuffix')}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {t('onboarding.runtimeMissingPrefix')} <code className="text-foreground/70">env: node: No such file or directory</code> {/* // i18n-scan-ignore */} {t('onboarding.runtimeMissingOr')} <code className="text-foreground/70">env: bun: No such file or directory</code> {/* // i18n-scan-ignore */}, {t('onboarding.runtimeMissingSuffix')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
