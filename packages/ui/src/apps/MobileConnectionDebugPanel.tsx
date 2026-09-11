import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

import { formatMobileConnectDebugEntry, getMobileConnectDebugEntries, getMobileConnectDebugText } from './mobileConnectionDebug';

// Hidden diagnostics surface for device-only connection bugs: renders the
// in-memory connection event trail with one-tap copy, so a user on a release
// build (no tethered debugger, no Web Inspector) can paste the exact probe
// sequence into a bug report. Opened via long-press easter eggs on the connect
// screen logo and the instances list — invisible unless you know it's there.
export const MobileConnectionDebugPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  // Snapshot on open; a live-updating log under the user's finger would fight
  // the copy button. Reopen to refresh.
  const entries = React.useMemo(() => getMobileConnectDebugEntries(), []);

  const handleCopy = React.useCallback(() => {
    void copyTextToClipboard(getMobileConnectDebugText()).then((result) => {
      if (!result.ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background pb-[var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))] pt-[var(--safe-area-inset-top,env(safe-area-inset-top,0px))] text-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-2.5">
        <h2 className="min-w-0 truncate typography-ui-label text-foreground">{t('mobile.connectionDebug.title')}</h2>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={entries.length === 0}>
            <Icon name={copied ? 'check' : 'file-copy'} className="size-4" />
            {copied ? t('mobile.connectionDebug.copied') : t('mobile.connectionDebug.copy')}
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={t('mobile.connectionDebug.close')} onClick={onClose}>
            <Icon name="close" className="size-[18px]" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
        {entries.length === 0 ? (
          <p className="typography-small text-muted-foreground">{t('mobile.connectionDebug.empty')}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words typography-code text-muted-foreground">
            {entries.map(formatMobileConnectDebugEntry).join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
};
