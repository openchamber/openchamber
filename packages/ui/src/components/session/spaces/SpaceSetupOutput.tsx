/**
 * The window with the end of a failed setup command's output (5d-4), opened from "Output" on the
 * group's status line. The output was printed by the project's code inside the space, so it is
 * plain text in a monospace block and never anything else. For a space that reaches only allowed
 * domains it lists, above the output, the domains the gatekeeper refused while the run went, each
 * with Allow; when it refused none, or the journal cannot say, there is no such list at all.
 *
 * Mounted once by the main layout and the mobile app, behind the switch; never in VS Code
 * (decision 16).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { setupBlockedDomainsOf } from '@/lib/spaces/space-access';
import { readSpaceSetup, type SpaceEntry, type SpaceSetupOutput } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { failureOfError, spaceFailureText } from './spaceFailureText';
import { useOpenSpaceDomain, useSpaceJournal } from './spaceNetwork';

type OutputRead = { kind: 'reading' } | { kind: 'read'; answer: SpaceSetupOutput } | { kind: 'failed'; reason: string };

/**
 * The domains the failed run could not reach, each with Allow, which turns into "Allowed" once the
 * space took it; the user runs setup again from the footer. Nothing while the journal is read, when
 * it cannot be read, or when it shows no such domain: the output then speaks for itself.
 */
const SetupBlockedDomains: React.FC<{ entry: SpaceEntry; span: { startedAt: string | null; finishedAt: string | null } }> = ({ entry, span }) => {
  const { t } = useI18n();
  const journal = useSpaceJournal(entry.id, true);
  const domains = useOpenSpaceDomain(entry.id);
  if (journal.state.kind !== 'ready') return null;
  const blocked = setupBlockedDomainsOf(journal.state.journal.records, span);
  if (blocked.length === 0) return null;
  const allowed = entry.network?.mode === 'allowlist' ? entry.network.domains : [];
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 px-2.5 py-2">
      <p className="typography-meta text-muted-foreground">{t('spaces.setup.output.blocked')}</p>
      <ul className="flex flex-col gap-1.5">
        {blocked.map((domain) => (
          <li key={domain} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-mono typography-meta text-foreground break-all">{domain}</div>
              {domains.error?.domain === domain ? <div className="typography-micro text-status-error">{domains.error.text}</div> : null}
            </div>
            {allowed.includes(domain)
              ? <span className="shrink-0 typography-micro text-muted-foreground">{t('spaces.access.blocked.opened')}</span>
              : (
                <Button variant="outline" size="xs" className="shrink-0 gap-1" disabled={domains.opening !== null} onClick={() => void domains.open(domain)}>
                  {domains.opening === domain ? <Icon name="loader-4" className="h-3 w-3 animate-spin" /> : null}
                  {t('spaces.access.openDomain')}
                </Button>
              )}
          </li>
        ))}
      </ul>
    </div>
  );
};

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
  const title = t('spaces.setup.output.title', { name: entry?.name ?? '' });

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
      {/* The journal is the running gatekeeper's memory; a stopped space has none to read. */}
      {entry?.network?.mode === 'allowlist' && entry.state === 'running' && setup?.state === 'failed'
        ? <SetupBlockedDomains key={failedAt} entry={entry} span={setup} />
        : null}
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
