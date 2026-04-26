import React from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { RiDiscordFill, RiGithubFill, RiTwitterXFill } from '@remixicon/react';
import { debugUtils } from '@/lib/debug';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

declare const __APP_VERSION__: string | undefined;

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const [version, setVersion] = React.useState<string | null>(null);
  const [isCopyingDiagnostics, setIsCopyingDiagnostics] = React.useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = React.useState(false);
  const [diagnosticsReport, setDiagnosticsReport] = React.useState<string | null>(null);
  const [isPreparingDiagnostics, setIsPreparingDiagnostics] = React.useState(false);

  const handleCopyDiagnostics = React.useCallback(async () => {
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
  }, [diagnosticsReport, isCopyingDiagnostics, t]);

  React.useEffect(() => {
    if (!open) return;

    const isDesktop = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);

    if (isDesktop) {
      const fetchVersion = async () => {
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          const v = await getVersion();
          setVersion(v);
        } catch {
          setVersion(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null);
        }
      };
      fetchVersion();
    } else {
      setVersion(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) {
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
  }, [open]);

  const displayVersion = version;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-6 max-h-[85vh] overflow-y-auto">
        <div className="flex flex-col items-center text-center space-y-4">
          <OpenChamberLogo width={64} height={64} />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">OpenChamber</h2>
            {displayVersion && (
              <p className="typography-meta text-muted-foreground">
                {t('aboutDialog.versionLabel', { version: displayVersion })}
              </p>
            )}
          </div>

          <p className="typography-meta text-muted-foreground">
            {t('aboutDialog.tagline')}
          </p>

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

          <div className="flex items-center gap-4 pt-2">
            <a
              href="https://github.com/btriapitsyn/openchamber"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
            >
              <RiGithubFill className="h-4 w-4" />
              <span>GitHub</span>
            </a>
            <a
              href="https://discord.gg/ZYRSdnwwKA"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
            >
              <RiDiscordFill className="h-4 w-4" />
              <span>Discord</span>
            </a>
            <a
              href="https://x.com/btriapitsyn"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
            >
              <RiTwitterXFill className="h-4 w-4" />
              <span>@btriapitsyn</span>
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
