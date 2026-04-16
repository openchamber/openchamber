import React from 'react';
import { RiFileCopyLine, RiCheckLine, RiExternalLinkLine } from '@remixicon/react';
import { isDesktopShell, isTauriShell } from '@/lib/desktop';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updateDesktopSettings } from '@/lib/persistence';
import { copyTextToClipboard } from '@/lib/clipboard';
import { restartDesktopApp } from '@/lib/desktop';
import { m } from '@/lib/i18n/messages';

const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';
const DOCS_URL = 'https://opencode.ai/docs';
const WINDOWS_WSL_DOCS_URL = 'https://opencode.ai/docs/windows-wsl';

type OnboardingPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

type LocalSetupScreenProps = {
  /** Callback when user goes back */
  onBack: () => void;
  /** Callback when CLI becomes available */
  onCliAvailable?: () => void;
  /** Whether this screen was entered from recovery flow (shows "Connect to Remote" link) */
  isFromRecovery?: boolean;
  /** Callback when user wants to switch to remote */
  onSwitchToRemote?: () => void;
};

function BashCommand({ onCopy }: { onCopy: () => void }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <code>
        <span style={{ color: 'var(--syntax-keyword)' }}>curl</span>
        <span className="text-muted-foreground"> -fsSL </span>
        <span style={{ color: 'var(--syntax-string)' }}>https://opencode.ai/install</span>
        <span className="text-muted-foreground"> | </span>
        <span style={{ color: 'var(--syntax-keyword)' }}>bash</span>
      </code>
      <button
        onClick={onCopy}
        className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
        title={m.obCopyToClipboard()}
      >
        <RiFileCopyLine className="h-4 w-4" />
      </button>
    </div>
  );
}

const HINT_DELAY_MS = 30000;

export function LocalSetupScreen({
  onBack,
  onCliAvailable,
  isFromRecovery = false,
  onSwitchToRemote,
}: LocalSetupScreenProps) {
  const [copied, setCopied] = React.useState(false);
  const [showHint, setShowHint] = React.useState(false);
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [isChecking, setIsChecking] = React.useState(false);
  const [checkError, setCheckError] = React.useState<string | null>(null);
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
        title: m.obSelectOpencodeBinary(),
        multiple: false,
        directory: false,
      });
      if (typeof selected === 'string' && selected.trim().length > 0) {
        setOpencodeBinary(selected.trim());
      }
    } catch {
      // ignore
    }
  }, [isDesktopApp]);

  const handleApplyPath = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      await updateDesktopSettings({ opencodeBinary: opencodeBinary.trim() });

      // In desktop boot flow, always restart the entire Tauri app so Rust
      // can re-evaluate the boot outcome with the updated binary path.
      if (isTauriShell()) {
        await restartDesktopApp();
        return;
      }

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

  const handleCheckAndContinue = React.useCallback(async () => {
    setIsChecking(true);
    setCheckError(null);
    try {
      const available = await checkCliAvailability();
      if (available) {
        // CLI is available, proceed to main screen
        onCliAvailable?.();
      } else {
        setCheckError(m.obCliNotReady());
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : m.obDetectionFailed());
    } finally {
      setIsChecking(false);
    }
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
      <div className="w-full max-w-lg space-y-4 text-center">
        <div className="flex items-center">
          <Button
            variant="ghost"
            onClick={onBack}
            className="p-0 text-muted-foreground hover:text-foreground"
          >
            &larr; {m.obBack()}
          </Button>
        </div>

        <div className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {m.obSettingUpOpenCode()}
          </h1>
          <p className="text-muted-foreground">
            {m.obInstallCliToContinue()}
          </p>
        </div>

        {platform === 'windows' && (
          <div className="mx-auto max-w-2xl rounded-lg border border-border bg-background/50 p-4 text-left">
            <div className="text-sm text-foreground">{m.obWindowsSetupTitle()}</div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{m.obWindowsSetupStep1()}</li>
              <li>{m.obWindowsSetupStep2()}</li>
              <li>{m.obWindowsSetupStep3()}</li>
            </ol>
          </div>
        )}

        <div className="flex justify-center">
          <div className="bg-background/60 backdrop-blur-sm border border-border rounded-lg px-5 py-3 font-mono text-sm w-fit">
            {copied ? (
              <div className="flex items-center justify-center gap-2" style={{ color: 'var(--status-success)' }}>
                <RiCheckLine className="h-4 w-4" />
                {m.obCopiedToClipboard()}
              </div>
            ) : (
              <BashCommand onCopy={handleCopy} />
            )}
          </div>
        </div>

        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1 justify-center"
        >
          {platform === 'windows' ? m.obViewWindowsDocumentation() : m.obViewDocumentation()}
          <RiExternalLinkLine className="h-3 w-3" />
        </a>

        {checkError && (
          <div className="mx-auto max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {checkError}
          </div>
        )}

        <div className="space-y-3">
          <Button
            type="button"
            onClick={handleCheckAndContinue}
            disabled={isChecking}
            className="w-full max-w-xs"
            size="lg"
          >
            {isChecking ? m.obChecking() : m.obCheckAndContinue()}
          </Button>

          <p className="text-xs text-muted-foreground">
            {m.obCheckButtonHelper()}
          </p>
        </div>

        <div className="mx-auto w-full max-w-xl pt-4">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">{m.obAlreadyInstalled()}</div>
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
                {m.obBrowse()}
              </Button>
              <Button
                type="button"
                onClick={handleApplyPath}
                disabled={isRetrying}
              >
                {m.obApply()}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground/70">{m.obBinaryPathHelper()}</div>
          </div>
        </div>

        {isFromRecovery && onSwitchToRemote && (
          <div className="text-center pt-4">
            <p className="text-sm text-muted-foreground mb-2">
              {m.obPreferRemoteServer()}
            </p>
            <Button
              variant="link"
              onClick={onSwitchToRemote}
            >
              {m.obConnectToRemoteServer()}
            </Button>
          </div>
        )}
      </div>

      {showHint && (
        <div className="absolute bottom-8 left-0 right-0 text-center space-y-1">
          {platform === 'windows' ? (
            <>
              <p className="text-sm text-muted-foreground/70">
                {m.obWindowsHint1()}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {m.obWindowsHint2()}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground/70">
                {m.obPathHint1()}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {m.obPathHint2()}
              </p>
              <p className="text-sm text-muted-foreground/70">
                {m.obPathHint3()}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
