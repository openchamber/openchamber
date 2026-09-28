/**
 * The window with the end of a failed setup command's output (5d-4), opened from "Output" on the
 * group's status line. The output was printed by the project's code inside the space, so it is
 * plain text in a monospace block and never anything else. For a space that reaches only allowed
 * addresses it says, above the output, where to open an address the command may have needed.
 *
 * Mounted once by the main layout and the mobile app, behind the switch; never in VS Code
 * (decision 16).
 */

import React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { readSpaceSetup, type SpaceSetupOutput } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { failureOfError, spaceFailureText } from './spaceFailureText';

type OutputRead = { kind: 'reading' } | { kind: 'read'; answer: SpaceSetupOutput } | { kind: 'failed'; reason: string };

export const SpaceSetupOutputDialog: React.FC = () => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const spaceId = useSpacesStore((state) => state.setupOutputDialog);
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  const [read, setRead] = React.useState<OutputRead>({ kind: 'reading' });

  // Read when opened, and again when the failure it shows changed: a run again that failed anew.
  const failedAt = entry?.setup?.state === 'failed' ? `${entry.setup.index}:${entry.setup.command}` : null;
  React.useEffect(() => {
    if (!spaceId) return;
    const controller = new AbortController();
    setRead({ kind: 'reading' });
    const readOutput = async () => {
      try {
        const answer = await readSpaceSetup(spaceId, controller.signal);
        if (!controller.signal.aborted) setRead({ kind: 'read', answer });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (!controller.signal.aborted) setRead({ kind: 'failed', reason: spaceFailureText(t, failureOfError(error)) });
      }
    };
    void readOutput();
    return () => controller.abort();
  }, [spaceId, failedAt, t]);

  const close = () => useSpacesStore.getState().closeSetupOutputDialog();
  const setup = read.kind === 'read' ? read.answer.setup : null;
  const allowlist = entry?.network?.mode === 'allowlist';
  const title = t('spaces.setup.output.title', { name: entry?.name ?? '' });

  const openAccess = () => {
    if (!spaceId) return;
    close();
    useSpacesStore.getState().openAccessDialog(spaceId);
  };
  const runAgain = () => {
    if (!spaceId) return;
    close();
    void runSpaceAction(spaceId, 'setup');
  };

  const body = (
    <div className="flex min-w-0 flex-col gap-3">
      {setup?.state === 'failed' ? (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="typography-meta text-muted-foreground">
            {t('spaces.setup.output.command', { current: setup.index + 1, total: setup.total })}
          </p>
          <code className="block min-w-0 whitespace-pre-wrap break-all rounded-md bg-[var(--surface-muted)] px-2 py-1 font-mono typography-meta text-foreground">{setup.command}</code>
          {setup.timedOut ? <p className="typography-meta text-muted-foreground">{t('spaces.setup.output.timedOut')}</p> : null}
        </div>
      ) : null}
      {allowlist ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-border/60 px-2.5 py-2">
          <p className="typography-meta text-muted-foreground">{t('spaces.setup.output.allowlistHint')}</p>
          <Button variant="outline" size="xs" className="self-start" onClick={openAccess}>{t('spaces.group.access.give')}</Button>
        </div>
      ) : null}
      {read.kind === 'reading' ? <p className="typography-meta text-muted-foreground">{t('spaces.setup.output.reading')}</p> : null}
      {read.kind === 'failed' ? <p className="typography-meta text-[var(--status-error)]">{t('spaces.setup.output.readFailed', { reason: read.reason })}</p> : null}
      {read.kind === 'read' && !read.answer.output ? <p className="typography-meta text-muted-foreground">{t('spaces.setup.output.empty')}</p> : null}
      {read.kind === 'read' && read.answer.output ? (
        <pre className="max-h-[50vh] min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--surface-muted)] p-2 font-mono text-[11px] leading-snug text-foreground">{read.answer.output}</pre>
      ) : null}
    </div>
  );
  const buttons = (
    <div className="flex w-full justify-end gap-2">
      <Button variant="outline" size="sm" onClick={close}>{t('spaces.setup.output.close')}</Button>
      <Button size="sm" onClick={runAgain} disabled={entry?.state !== 'running' || entry.setup?.state === 'running'}>{t('spaces.actions.setup')}</Button>
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel open={spaceId !== null} title={title} onClose={close} footer={buttons}>
        <div className="px-3 pb-4 pt-1">{body}</div>
      </MobileOverlayPanel>
    );
  }
  return (
    <Dialog open={spaceId !== null} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{t('spaces.setup.output.description')}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>{buttons}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
