import React from 'react';

import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

export const GuestToastActions = ({ copyText, dismiss, onDismiss }: {
  copyText: string | undefined;
  dismiss: boolean;
  onDismiss: () => void;
}) => {
  const { t } = useI18n();
  const [copyState, setCopyState] = React.useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    if (copyText === undefined || copyState === 'copying') return;
    setCopyState('copying');
    try {
      const result = await copyTextToClipboard(copyText);
      setCopyState(result.ok ? 'copied' : 'failed');
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {copyText !== undefined && <Button type="button" variant="secondary" size="xs" disabled={copyState === 'copying'} onClick={() => void copy()} aria-live="polite">
          {t(copyState === 'copied' ? 'contextPanel.plugin.toast.copied' : 'contextPanel.plugin.toast.copy')}
        </Button>}
        {dismiss && <Button type="button" size="xs" onClick={onDismiss}>{t('contextPanel.plugin.toast.ok')}</Button>}
      </div>
      {copyState === 'failed' && <span role="status" className="typography-micro text-[var(--status-error-text)]">{t('contextPanel.plugin.toast.copyFailed')}</span>}
    </div>
  );
};
