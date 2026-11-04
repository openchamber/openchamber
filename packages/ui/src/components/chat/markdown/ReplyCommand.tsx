import React from 'react';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import type { ReplyCommandRun } from '@/lib/opencode/reply-command';
import { cn } from '@/lib/utils';
import { useRunningShell } from '@/sync/background-shells';
import { renderTerminalOutput } from '../message/parts/toolOutput';
import { keepTail, useShellOutput } from '../message/parts/useShellOutput';
import { useReplyCommand, type ReplyCommand } from './useReplyCommand';

function ReplyCommandButton({ command }: { command: ReplyCommand }) {
  const { t } = useI18n();
  const { running, starting, start, stop } = command;
  return (
    <HoverTooltip label={t(running ? 'markdownRenderer.code.actions.stopTitle' : 'markdownRenderer.code.actions.runTitle')}>
      <Button
        variant="ghost"
        size="xs"
        data-export-ignore
        data-reply-command-run
        disabled={starting}
        aria-label={t(running ? 'markdownRenderer.code.actions.stopTitle' : 'markdownRenderer.code.actions.runTitle')}
        onClick={running ? stop : start}
      >
        {starting ? <Spinner className="size-3.5" /> : <Icon name={running ? 'stop' : 'play'} className="size-3.5" />}
      </Button>
    </HoverTooltip>
  );
}

type Outcome = { kind: 'running' | 'finished' | 'stopped' } | { kind: 'failed'; code: number };

const outcomeOf = ({ shell, completion }: ReplyCommandRun): Outcome => {
  if (shell.status === 'running') return { kind: 'running' };
  if (shell.status === 'killed' || completion?.state === 'cancelled') return { kind: 'stopped' };
  const code = shell.exit ?? 0;
  return code === 0 ? { kind: 'finished' } : { kind: 'failed', code };
};

// The block is the surface; the highlighter's own code background would be a box inside it.
const TRANSPARENT: React.CSSProperties = { background: 'transparent', backgroundColor: 'transparent' };

const OUTCOME_LOOK = {
  running: { icon: null, className: 'text-muted-foreground' },
  finished: { icon: 'check', className: 'text-[var(--status-success)]' },
  stopped: { icon: 'stop', className: 'text-muted-foreground' },
  failed: { icon: 'error-warning', className: 'text-[var(--status-error)]' },
} as const;

/** What the command printed, under its code: live while it runs, then the recorded output. */
function ReplyCommandOutput({ run }: { run: ReplyCommandRun }) {
  const { t } = useI18n();
  const { shell } = run;
  const running = shell.status === 'running';
  const tracked = useRunningShell(running ? shell.shellID : undefined);
  const live = useShellOutput(shell.shellID, tracked?.directory, running && tracked !== undefined);
  const outcome = outcomeOf(run);
  // OpenCode drops the output of a command that was stopped, so what was on screen stays.
  const raw = running || outcome.kind === 'stopped' ? live : keepTail(shell.output?.output ?? '');
  const output = React.useMemo(() => renderTerminalOutput(raw).trimEnd(), [raw]);
  const look = OUTCOME_LOOK[outcome.kind];

  const scroller = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    if (running && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [output, running]);

  return (
    <div data-reply-command-output className="border-t border-[color-mix(in_srgb,var(--border)_70%,transparent)]">
      <div className={cn(
        'flex min-h-8 items-center gap-1.5 px-3 typography-meta',
        output && 'border-b border-[color-mix(in_srgb,var(--border)_70%,transparent)]',
        look.className,
      )}>
        {look.icon ? <Icon name={look.icon} className="size-3.5 shrink-0" /> : <Spinner className="size-3.5 shrink-0" />}
        <span>
          {outcome.kind === 'failed'
            ? t('markdownRenderer.code.run.failed', { code: outcome.code })
            : t(`markdownRenderer.code.run.${outcome.kind}`)}
        </span>
      </div>
      {output ? (
        <div
          ref={scroller}
          className="max-h-80 overflow-auto px-3 py-2.5 font-mono text-[length:var(--text-code)] text-foreground"
        >
          {/* Like a shell tool row: plain while it streams, highlighted once it settles. */}
          {running
            ? <pre className="m-0 whitespace-pre-wrap break-words">{output}</pre>
            : <WorkerHighlightedCode language="bash" code={output} style={TRANSPARENT} wrap />}
        </div>
      ) : null}
    </div>
  );
}

export type RenderedCommand = { button: React.ReactNode; output: React.ReactNode };

/** A command block's run button and result, handed to the block that draws the code. */
export function ReplyCommandCode({ reply, directory, source, children }: {
  reply: { sessionId: string; messageId: string };
  directory: string;
  source: string;
  children: (command: RenderedCommand) => React.ReactNode;
}) {
  const command = useReplyCommand(reply, directory, source);
  return children({
    button: <ReplyCommandButton command={command} />,
    output: command.run ? <ReplyCommandOutput key={command.run.shell.id} run={command.run} /> : null,
  });
}
