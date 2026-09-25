import * as React from 'react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { AppStartupOverlay } from '@/components/ui/AppStartupOverlay';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { useI18n } from '@/lib/i18n';
import { hasCompatibleManagedDesktopOpenCode } from '@/lib/desktop';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { fetchOpenCodeCompatibility, recoverOpenCode, type OpenCodeCompatibility } from '@/lib/opencode/compatibility';

export const OpenCodeCompatibilityGate: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { t } = useI18n();
  const [compatibility, setCompatibility] = React.useState<OpenCodeCompatibility | null>(null);
  const [checked, setChecked] = React.useState(false);
  const titleId = React.useId();
  const [operation, setOperation] = React.useState<'install-v2' | 'reconnect' | null>(null);
  const [failed, setFailed] = React.useState(false);
  const generation = React.useRef(0);

  React.useEffect(() => {
    let mounted = true;
    const check = async () => {
      const revision = ++generation.current;
      try {
        if (await hasCompatibleManagedDesktopOpenCode()) return;
        if (!mounted || revision !== generation.current) return;
        const result = await fetchOpenCodeCompatibility();
        if (mounted && revision === generation.current) setCompatibility(result);
      } catch {
        // An unavailable host or an older OpenChamber host keeps its existing
        // connection UI. Failed reads never dismiss a known incompatible CLI.
      } finally {
        if (mounted && revision === generation.current) setChecked(true);
      }
    };
    void check();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      generation.current += 1;
      setCompatibility(null);
      setChecked(false);
      setOperation(null);
      setFailed(false);
      void check();
    });
    return () => { mounted = false; generation.current += 1; unsubscribe(); };
  }, []);

  React.useEffect(() => {
    if (compatibility?.state === 'incompatible') {
      // The application cannot initialize against v1. Recovery owns the screen
      // before App mounts, including dismissal of the HTML loading overlay.
      document.getElementById('initial-loading')?.remove();
    }
  }, [compatibility]);

  const recover = async (action: 'install-v2' | 'reconnect') => {
    if (operation) return;
    const revision = ++generation.current;
    setOperation(action);
    setFailed(false);
    try {
      const result = await recoverOpenCode(action);
      if (revision !== generation.current) return;
      if (result.state === 'incompatible') setCompatibility(result.compatibility);
      else window.location.reload();
    } catch {
      if (revision === generation.current) setFailed(true);
    } finally {
      if (revision === generation.current) setOperation(null);
    }
  };

  if (!checked) {
    return <AppStartupOverlay ready={false} />;
  }
  if (compatibility?.state !== 'incompatible') return <>{children}</>;
  const external = compatibility.installation === 'external';
  const bundled = compatibility.installation === 'bundled';
  // A 2.x below the minimum needs an update, not the v1 → v2 move.
  const minimum = compatibility.minimumVersion;
  const outdated = Boolean(minimum && compatibility.version?.startsWith('2.'));
  const descriptionKey = bundled
    ? 'opencodeCompatibility.bundled'
    : outdated
      ? external ? 'opencodeCompatibility.outdatedExternal' : 'opencodeCompatibility.outdatedLocal'
      : external ? 'opencodeCompatibility.external' : 'opencodeCompatibility.local';
  return (
    <section className="app-region-drag flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground select-none" aria-labelledby={titleId}>
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <OpenChamberLogo width={48} height={48} />
        <h1 id={titleId} className="mt-6 text-xl font-semibold tracking-tight">{t(outdated ? 'opencodeCompatibility.outdatedTitle' : 'opencodeCompatibility.title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-balance">
          {t(descriptionKey, { version: compatibility.version ?? '', minimum: minimum ?? '' })}
          {compatibility.canInstall && <> {t('opencodeCompatibility.installDescription')}</>}
        </p>
        {compatibility.version && (
          <div className="mt-5 inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1 font-mono text-xs" aria-hidden>
            <span className="text-muted-foreground">{compatibility.version}</span>
            <Icon name="arrow-right" className="size-3.5 text-muted-foreground" />
            <span className="text-foreground">{outdated ? `${minimum}+` : '2.x'}</span>
          </div>
        )}
        {failed && <p role="alert" className="mt-5 rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error-background)] px-3 py-2 text-sm text-[var(--status-error-text)]">{t('opencodeCompatibility.failed')}</p>}
        <div className="app-region-no-drag mt-7 flex flex-wrap items-center justify-center gap-2">
          {compatibility.canInstall && (
            <Button disabled={operation !== null} onClick={() => void recover('install-v2')}>
              <Icon name={operation === 'install-v2' ? 'refresh' : 'download'} className={operation === 'install-v2' ? 'size-4 animate-spin' : 'size-4'} />
              <span role={operation === 'install-v2' ? 'status' : undefined}>{t(operation === 'install-v2' ? 'opencodeCompatibility.installing' : outdated ? 'opencodeCompatibility.update' : 'opencodeCompatibility.install')}</span>
            </Button>
          )}
          <Button variant={compatibility.canInstall ? 'ghost' : 'default'} disabled={operation !== null} onClick={() => void recover('reconnect')}>
            <Icon name="refresh" className={operation === 'reconnect' ? 'size-4 animate-spin' : 'size-4'} />
            <span role={operation === 'reconnect' ? 'status' : undefined}>{t(operation === 'reconnect' ? 'opencodeCompatibility.reconnecting' : 'opencodeCompatibility.reconnect')}</span>
          </Button>
        </div>
        <a
          className="app-region-no-drag mt-6 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          href={bundled ? 'https://github.com/openchamber/openchamber/releases/latest' : 'https://opencode.ai/download'}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('opencodeCompatibility.guide')}
          <Icon name="external-link" className="size-3" />
        </a>
        <div className="app-region-no-drag mt-3 w-full">
          <DesktopHostSwitcherInline />
        </div>
      </div>
    </section>
  );
};
