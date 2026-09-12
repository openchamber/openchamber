import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import type { useRemoteBrowserClipboard } from './useRemoteBrowserClipboard';

type Props = {
  readonly clipboard: ReturnType<typeof useRemoteBrowserClipboard>;
  readonly focusInput: () => void;
};

export function RemoteBrowserClipboardControls({ clipboard, focusInput }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  const fallbackInput = React.useRef<HTMLTextAreaElement>(null);
  const copying = clipboard.fallback?.kind === 'copy';

  React.useEffect(() => { setDraft(''); }, [clipboard.fallback]);

  return <>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 border-t border-border bg-background px-2 py-1">
      {clipboard.feedback ? <p role="status" className="mr-auto max-w-full typography-meta text-muted-foreground">
        {t(clipboard.feedback)}
      </p> : null}
      <div className="flex max-w-full flex-wrap justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={focusInput}>{t('contextPanel.browser.remote.keyboard')}</Button>
        <Button variant="ghost" size="xs" disabled={clipboard.busy} onClick={() => void clipboard.copy()}>
          <Icon name="file-copy" className="size-4" />{t('contextPanel.browser.remote.clipboard.copy')}
        </Button>
        <Button variant="ghost" size="xs" disabled={clipboard.busy} onClick={() => void clipboard.paste()}>
          <Icon name="clipboard" className="size-4" />{t('contextPanel.browser.remote.clipboard.paste')}
        </Button>
      </div>
    </div>
    <Dialog open={clipboard.fallback !== null} onOpenChange={(open) => { if (!open) clipboard.closeFallback(); }}>
      <DialogContent initialFocus={fallbackInput} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t(copying ? 'contextPanel.browser.remote.clipboard.copyFallbackTitle' : 'contextPanel.browser.remote.clipboard.pasteFallbackTitle')}</DialogTitle>
          <DialogDescription>{t(copying ? 'contextPanel.browser.remote.clipboard.copyFallbackDescription' : 'contextPanel.browser.remote.clipboard.pasteFallbackDescription')}</DialogDescription>
        </DialogHeader>
        <Textarea ref={fallbackInput} readOnly={copying}
          aria-label={t(copying ? 'contextPanel.browser.remote.clipboard.copyTextAria' : 'contextPanel.browser.remote.clipboard.pasteTextAria')}
          value={clipboard.fallback?.kind === 'copy' ? clipboard.fallback.text : draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onFocus={(event) => { if (copying) event.currentTarget.select(); }} />
        {clipboard.feedback ? <p role="status" className="typography-meta text-foreground">{t(clipboard.feedback)}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={clipboard.closeFallback}>{t('contextPanel.browser.remote.clipboard.cancel')}</Button>
          <Button disabled={!copying && !draft} onClick={() => { if (copying) void clipboard.retryCopy(); else clipboard.pasteText(draft); }}>
            {t(copying ? 'contextPanel.browser.remote.clipboard.copy' : 'contextPanel.browser.remote.clipboard.paste')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
