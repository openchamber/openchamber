import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isSessionPriority } from '@/lib/sessionPriority';
import { getPendingQuestion } from '@/lib/questions/pendingQuestion';
import { cn } from '@/lib/utils';
import { getRestartInterruption, type RestartInterruption, type RestartInterruptionCause } from '@/lib/sessionRestartInterruption';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { isVSCodeRuntime } from '@/lib/desktop';
import { continueAfterRestart, dismissRestartInterruption } from '@/sync/session-actions';
import { useSession, useSessionStatus } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';

interface SessionRestartInterruptionRowProps {
  sessionId: string | null;
  directory?: string;
  /** The question the restart cut off is in the form dock, waiting for an answer. */
  questionAnswerable: boolean;
}

const CAUSE_KEYS = {
  'memory-pressure': 'chat.restartInterruption.cause.memoryPressure',
  'health-timeout': 'chat.restartInterruption.cause.healthTimeout',
  'process-exited': 'chat.restartInterruption.cause.processExited',
  unknown: null,
} as const satisfies Record<RestartInterruptionCause, I18nKey | null>;

type ResumeLine = { key: I18nKey; params?: { time: string } };

/** The line a priority session shows about the server's automatic resume. */
const resumeLine = (interruption: RestartInterruption, formatTime: (timestamp: number) => string) => {
  const { resume } = interruption;
  if (!resume || resume.state === 'waiting') {
    return interruption.cause === 'memory-pressure'
      ? { key: 'chat.restartInterruption.resume.waitingMemory' } satisfies ResumeLine
      : { key: 'chat.restartInterruption.resume.waiting' } satisfies ResumeLine;
  }
  if (resume.state === 'sent') {
    return { key: 'chat.restartInterruption.resume.sent', params: { time: formatTime(resume.at) } } satisfies ResumeLine;
  }
  return { key: MANUAL_REASON_KEYS[resume.reason ?? 'send-failed'] } satisfies ResumeLine;
};

const MANUAL_REASON_KEYS = {
  'memory-timeout': 'chat.restartInterruption.resume.memoryTimeout',
  'memory-unreadable': 'chat.restartInterruption.resume.memoryUnreadable',
  'send-failed': 'chat.restartInterruption.resume.failed',
  'question-pending': 'chat.restartInterruption.resume.questionPending',
} as const satisfies Record<NonNullable<NonNullable<RestartInterruption['resume']>['reason']>, I18nKey>;

interface RestartInterruptionNoticeProps {
  interruption: RestartInterruption;
  /** A priority session: the server resumes it on its own, and the notice is stronger. */
  priority: boolean;
  /** This runtime's server can send the resume (not VS Code, which has no route for it). */
  continueAvailable: boolean;
  /** A time as the user reads clocks. */
  formatTime: (timestamp: number) => string;
  busy: boolean;
  onContinue: () => void;
  onDismiss: () => void;
}

/** What the notice shows for one restart record. */
export const RestartInterruptionNotice: React.FC<RestartInterruptionNoticeProps> = ({
  interruption, priority, continueAvailable, formatTime, busy, onContinue, onDismiss,
}) => {
  const { t } = useI18n();
  const causeKey = CAUSE_KEYS[interruption.cause];
  const question = interruption.tool?.name === 'question';
  const toolText = interruption.tool && !question ? (interruption.tool.input || interruption.tool.name) : null;
  const resume = priority ? resumeLine(interruption, formatTime) : null;
  // Once the server sent the resume, a manual one would repeat it.
  const canContinue = continueAvailable && (!priority || interruption.resume?.state !== 'sent');

  return (
    <div
      className={cn(
        'flex items-start gap-2 border-b py-2 ps-3 pe-1.5',
        priority ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]' : 'border-border/60',
      )}
      data-priority={priority ? 'true' : undefined}
    >
      <Icon name={priority ? 'flag' : 'error-warning'} className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" />
      <div className={cn('min-w-0 flex-1 text-sm', priority ? 'text-foreground' : 'text-muted-foreground')}>
        {priority ? <p className="font-medium text-[var(--status-warning)]">{t('chat.restartInterruption.priorityLabel')}</p> : null}
        <p>
          {t('chat.restartInterruption.text', { time: formatTime(interruption.at) })}
          {causeKey ? <> {t(causeKey)}</> : null}
        </p>
        {question ? <p className="mt-0.5">{t('chat.restartInterruption.questionLost')}</p> : null}
        {toolText ? (
          <p className="mt-0.5 flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">{t('chat.restartInterruption.toolLabel')}</span>
            <code className="min-w-0 truncate font-mono text-xs text-foreground/80" title={toolText}>{toolText}</code>
          </p>
        ) : null}
        {resume ? <p className="mt-0.5">{'params' in resume ? t(resume.key, resume.params) : t(resume.key)}</p> : null}
      </div>
      {canContinue ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onContinue}
          onMouseDown={(event) => event.preventDefault()}
          className="shrink-0 text-foreground/80 hover:bg-transparent hover:text-foreground"
        >
          {t('chat.restartInterruption.continue')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onDismiss}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('chat.restartInterruption.dismiss')}
      </Button>
    </div>
  );
};

/**
 * A managed OpenCode restart killed this session's running turn. The notice
 * says when and why, and which command was running; Continue has the server
 * send the agent a message asking it to check what already happened before
 * repeating anything, and clears the notice. While a question the restart
 * cut off is answerable in the form dock, its card says when and why and the
 * notice stays hidden. A priority session also shows how the server's automatic resume
 * went. The record goes away with the next message, Continue or Dismiss.
 */
export const SessionRestartInterruptionRow: React.FC<SessionRestartInterruptionRowProps> = React.memo(({ sessionId, directory, questionAnswerable }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory);
  const status = useSessionStatus(sessionId ?? '', directory);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [pending, setPending] = React.useState(false);
  const interruption = getRestartInterruption(session);
  const pendingQuestion = getPendingQuestion(session);
  const priority = isSessionPriority(session);
  // A cut-off question still answerable says all of this in its own card in
  // the form dock, so the notice and its chip stay out of the way.
  // The record says a question is answerable before the messages that let
  // the dock show it have loaded; the notice must not flash in between.
  const answeredInDock = interruption?.tool?.name === 'question' && (questionAnswerable || pendingQuestion !== null);
  const visible = Boolean(sessionId && interruption && !answeredInDock && (!status || status.type === 'idle'));

  if (!visible || !sessionId || !interruption) return null;

  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  const handleDismiss = () => run(async () => {
    try {
      await dismissRestartInterruption(sessionId, directory);
    } catch {
      toast.error(t('chat.restartInterruption.dismissFailed'));
    }
  });

  // A conflict means the record changed meanwhile (another client continued
  // or dismissed it, or a newer restart replaced it); its update follows.
  const handleContinue = () => run(async () => {
    const outcome = await continueAfterRestart(sessionId, directory, interruption.at).catch(() => 'send-failed' as const);
    if (outcome === 'send-failed') toast.error(t('chat.restartInterruption.continueFailed'));
  });

  return (
    <RestartInterruptionNotice
      interruption={interruption}
      priority={priority}
      continueAvailable={!isVSCodeRuntime()}
      formatTime={(timestamp) => formatTimeForPreference(timestamp, timeFormatPreference)}
      busy={pending}
      onContinue={() => { void handleContinue(); }}
      onDismiss={() => { void handleDismiss(); }}
    />
  );
});

SessionRestartInterruptionRow.displayName = 'SessionRestartInterruptionRow';
