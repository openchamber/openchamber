import React from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { debugUtils } from '@/lib/debug';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { runtimeFetch } from '@/lib/runtime-fetch';

const VERSION_SLOT = '\u0000';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const showDiagnostics = import.meta.env.DEV;
  // undefined while the first lookup runs, null once it finished without a version.
  const [version, setVersion] = React.useState<string | null | undefined>(undefined);
  const [openCodeVersion, setOpenCodeVersion] = React.useState<string | null | undefined>(undefined);
  const [isCopyingDiagnostics, setIsCopyingDiagnostics] = React.useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = React.useState(false);
  const [diagnosticsReport, setDiagnosticsReport] = React.useState<string | null>(null);
  const [isPreparingDiagnostics, setIsPreparingDiagnostics] = React.useState(false);

  const handleCopyDiagnostics = React.useCallback(async () => {
    if (!showDiagnostics) return;
    if (isCopyingDiagnostics) return;
    setIsCopyingDiagnostics(true);
    setCopiedDiagnostics(false);
    try {
      if (!diagnosticsReport) {
        toast.error(t('aboutDialog.toast.copyFailed'), {
          description: t('aboutDialog.toast.diagnosticsNotReady'),
        });
        return;
      }

      const result = await debugUtils.copyTextToClipboard(diagnosticsReport);
      if (result.ok) {
        setCopiedDiagnostics(true);
        toast.success(t('aboutDialog.toast.diagnosticsCopied'));
      } else {
        toast.error(t('aboutDialog.toast.copyFailed'), {
          description: result.error,
        });
      }
    } catch (error) {
      toast.error(t('aboutDialog.toast.copyFailed'));
      console.error('Failed to copy diagnostics:', error);
    } finally {
      setIsCopyingDiagnostics(false);
    }
  }, [diagnosticsReport, isCopyingDiagnostics, showDiagnostics, t]);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const fetchVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info');
        if (response.ok) {
          const data = await response.json();
          if (typeof data.openchamberVersion === 'string' && data.openchamberVersion.trim()) {
            if (!cancelled) setVersion(data.openchamberVersion);
            return;
          }
        }
      } catch {
        // Fall back to the native shell version when the web server is unavailable.
      }

      const desktopVersion = await getDesktopAppVersion().catch(() => null);
      if (!cancelled) setVersion(desktopVersion);
    };

    void fetchVersion();
    return () => {
      cancelled = true;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const fetchOpenCodeVersion = async () => {
      let currentVersion = '';
      try {
        const response = await runtimeFetch('/api/opencode/upgrade-status', {
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const data = await response.json().catch(() => null) as null | { currentVersion?: unknown };
          currentVersion = typeof data?.currentVersion === 'string' ? data.currentVersion.trim() : '';
        }
      } catch {
        // OpenCode version is best-effort in About.
      }
      if (!cancelled) setOpenCodeVersion(currentVersion || null);
    };

    void fetchOpenCodeVersion();
    return () => {
      cancelled = true;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open || !showDiagnostics) {
      setDiagnosticsReport(null);
      setIsPreparingDiagnostics(false);
      return;
    }

    let cancelled = false;
    setIsPreparingDiagnostics(true);
    void debugUtils.buildDiagnosticsReport()
      .then((report) => {
        if (cancelled) return;
        setDiagnosticsReport(report);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to prepare diagnostics:', error);
        setDiagnosticsReport(null);
      })
      .finally(() => {
        if (cancelled) return;
        setIsPreparingDiagnostics(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, showDiagnostics]);

  // Both rows render from the first frame so the dialog height stays put while versions load.
  const renderVersionRow = (labelKey: 'aboutDialog.openChamberVersionLabel' | 'aboutDialog.openCodeVersionLabel', value: string | null | undefined) => {
    if (value !== undefined) {
      return <p>{t(labelKey, { version: value ?? t('settings.openchamber.about.state.unknown') })}</p>;
    }
    const [before, after = ''] = t(labelKey, { version: VERSION_SLOT }).split(VERSION_SLOT);
    return (
      <p className="flex items-center justify-center">
        <span className="whitespace-pre">{before}</span>
        <Icon name="loader" className="size-3.5 animate-spin" />
        <span className="whitespace-pre">{after}</span>
      </p>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-6">
        <div className="flex flex-col items-center text-center space-y-4">
          <OpenChamberLogo width={64} height={64} />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">OpenChamber</h2>
            <div className="space-y-0.5 typography-meta text-muted-foreground">
              {renderVersionRow('aboutDialog.openChamberVersionLabel', version)}
              {renderVersionRow('aboutDialog.openCodeVersionLabel', openCodeVersion)}
            </div>
          </div>

          {showDiagnostics && (
            <div className="flex flex-col items-center gap-2 pt-2">
              <button
                onClick={handleCopyDiagnostics}
                disabled={isCopyingDiagnostics || isPreparingDiagnostics || !diagnosticsReport}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground',
                  'underline-offset-2 hover:underline',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {copiedDiagnostics
                  ? t('aboutDialog.actions.diagnosticsCopied')
                  : isPreparingDiagnostics
                    ? t('aboutDialog.actions.preparingDiagnostics')
                    : t('aboutDialog.actions.copyDiagnostics')}
              </button>
              <p className="typography-micro text-muted-foreground">
                {t('aboutDialog.diagnosticsDescription')}
              </p>
            </div>
          )}

          <div className="flex flex-col items-center gap-2 pt-2">
            <div className="flex items-center justify-center gap-4">
              <a
                href="https://github.com/openchamber/openchamber"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
              >
                <Icon name="github-fill" className="h-4 w-4" />
                <span>GitHub</span>
              </a>
              <a
                href="https://discord.gg/ZYRSdnwwKA"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
              >
                <Icon name="discord-fill" className="h-4 w-4" />
                <span>Discord</span>
              </a>
            </div>
            <a
              href="https://x.com/openchamber_dev"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icon name="twitter-xfill" className="h-4 w-4" />
              <span>@openchamber_dev</span>
            </a>
          </div>

          <p className="typography-meta text-muted-foreground/60 pt-2">
            {t('aboutDialog.footerNote')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};
