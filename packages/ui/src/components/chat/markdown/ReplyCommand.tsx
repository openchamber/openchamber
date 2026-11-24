import React from 'react';
import { HighlightedCode } from '@/components/code/HighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openMobileWorkspace } from '@/lib/mobileWorkspaceTabs';
import type { ReplyCommandRun } from '@/lib/opencode/reply-command';
import { cn } from '@/lib/utils';
import { useRunningShell } from '@/sync/background-shells';
import { renderTerminalOutput } from '../message/parts/toolOutput';
import { keepTail, useShellOutput } from '../message/parts/useShellOutput';
import { useChatSurfaceMode } from '../useChatSurfaceMode';
import { replyCommandShell, ReplyTerminalUnsupportedError, startReplyTerminal } from './replyTerminal';
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

function ReplyTerminalButton({ directory, language, source }: { directory: string; language: string; source: string }) {
  const { t } = useI18n();
  const { terminal, runtime } = useRuntimeAPIs();
  const { currentTheme } = useThemeSystem();
  const surface = useChatSurfaceMode();
  const [starting, setStarting] = React.useState(false);
  const pending = React.useRef(false);
  const available = !runtime.isVSCode && surface !== 'mini-chat';

  const start = async () => {
    if (pending.current || !available || !directory.trim() || !source.trim()) return;
    pending.current = true;
    setStarting(true);
    const runtimeKey = getRuntimeKey();
    const isCurrent = () => runtimeKey === getRuntimeKey();
    const settings = useUIStore.getState();
    const conversation = useSessionUIStore.getState().currentSessionId;
    try {
      const tabId = await startReplyTerminal({
        terminal,
        directory,
        command: source,
        shell: replyCommandShell(language, settings.terminalShell),
        loginShells: settings.terminalLoginShells,
        createOptions: {
          cols: 80,
          rows: 24,
          themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
          terminalBackground: currentTheme.colors.surface.background,
          terminalForeground: currentTheme.colors.syntax.base.foreground,
        },
        isCurrent,
      });
      if (tabId && useSessionUIStore.getState().currentSessionId === conversation && !openMobileWorkspace({ tab: 'terminal' })) {
        useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
      }
    } catch (error) {
      if (isCurrent()) {
        toast.error(t('terminalView.error.startSessionFailed'), {
          description: error instanceof Error && !(error instanceof ReplyTerminalUnsupportedError) ? error.message : undefined,
        });
      }
    } finally {
      pending.current = false;
      setStarting(false);
    }
  };

  if (!available) return null;
  const label = t('markdownRenderer.code.actions.runInTerminalTitle');
  return (
    <HoverTooltip label={label}>
      <Button variant="ghost" size="xs" data-export-ignore data-reply-command-terminal
        disabled={starting} aria-label={label} onClick={() => void start()}>
        {starting ? <Spinner className="size-3.5" /> : <Icon name="terminal" className="size-3.5" />}
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

const TRANSPARENT: React.CSSProperties = { background: 'transparent', backgroundColor: 'transparent' };

const OUTCOME_LOOK = {
  running: { icon: null, className: 'text-muted-foreground' },
  finished: { icon: 'check', className: 'text-[var(--status-success)]' },
  stopped: { icon: 'stop', className: 'text-muted-foreground' },
  failed: { icon: 'error-warning', className: 'text-[var(--status-error)]' },
} as const;

function ReplyCommandOutput({ run }: { run: ReplyCommandRun }) {
  const { t } = useI18n();
  const { shell } = run;
  const running = shell.status === 'running';
  const tracked = useRunningShell(running ? shell.shellID : undefined);
  const live = useShellOutput(shell.shellID, tracked?.directory, running && tracked !== undefined);
  const outcome = outcomeOf(run);
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
          {running
            ? <pre className="m-0 whitespace-pre-wrap break-words">{output}</pre>
            : <HighlightedCode language="bash" code={output} style={TRANSPARENT} wrap />}
        </div>
      ) : null}
    </div>
  );
}

export type RenderedCommand = { button: React.ReactNode; output: React.ReactNode };

export function ReplyCommandCode({ reply, directory, language, source, children }: {
  reply: { sessionId: string; messageId: string };
  directory: string;
  language: string;
  source: string;
  children: (command: RenderedCommand) => React.ReactNode;
}) {
  const command = useReplyCommand(reply, directory, source);
  return children({
    button: <>
      <ReplyCommandButton command={command} />
      <ReplyTerminalButton directory={directory} language={language} source={source} />
    </>,
    output: command.run ? <ReplyCommandOutput key={command.run.shell.id} run={command.run} /> : null,
  });
}
