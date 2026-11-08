import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isDesktopLocalOriginActive, revealDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';

type SnapshotState =
  | { kind: 'idle' }
  | { kind: 'writing' }
  | { kind: 'written'; path: string }
  | { kind: 'failed' };

/**
 * Writes a heap snapshot of the OpenCode server for a memory report. The file
 * stays where OpenCode wrote it, on the OpenCode machine; nothing uploads it,
 * because it can hold API keys, prompts and file contents.
 */
export const OpenCodeHeapSnapshot: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = React.useState<SnapshotState>({ kind: 'idle' });

  const handleWrite = React.useCallback(async () => {
    setState({ kind: 'writing' });
    try {
      const { path } = await opencodeClient.writeHeapSnapshot();
      setState({ kind: 'written', path });
    } catch {
      setState({ kind: 'failed' });
    }
  }, []);

  const handleReveal = React.useCallback(async (path: string) => {
    if (!(await revealDesktopPath(path))) toast.error(t('openCodeStatusDialog.heapSnapshot.revealFailed'));
  }, [t]);

  const handleCopyPath = React.useCallback(async (path: string) => {
    const result = await copyTextToClipboard(path);
    if (result.ok) toast.success(t('openCodeStatusDialog.heapSnapshot.pathCopied'));
    else toast.error(t('openCodeStatusDialog.heapSnapshot.copyFailed'));
  }, [t]);

  const status = (() => {
    switch (state.kind) {
      case 'idle': return t('openCodeStatusDialog.heapSnapshot.hint');
      case 'writing': return t('openCodeStatusDialog.heapSnapshot.writing');
      case 'written': return t('openCodeStatusDialog.heapSnapshot.written', { path: state.path });
      case 'failed': return t('openCodeStatusDialog.heapSnapshot.failed');
    }
  })();

  return (
    <div className="flex items-center gap-2">
      {state.kind === 'writing' && <Spinner className="text-muted-foreground" aria-hidden />}
      <p
        className={state.kind === 'failed' ? 'min-w-0 flex-1 truncate typography-meta text-destructive' : 'min-w-0 flex-1 truncate typography-meta text-muted-foreground'}
        title={status}
      >
        {status}
      </p>
      {state.kind === 'written' && (
        isDesktopLocalOriginActive() ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleReveal(state.path)}>
            {t('openCodeStatusDialog.heapSnapshot.reveal')}
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleCopyPath(state.path)}>
            {t('openCodeStatusDialog.heapSnapshot.copyPath')}
          </Button>
        )
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => void handleWrite()} disabled={state.kind === 'writing'}>
        {t('openCodeStatusDialog.heapSnapshot.action')}
      </Button>
    </div>
  );
};
