import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { RemoteSurfaceInspectorError, type RemoteSurfaceInspector } from '@/lib/browser/remoteSurfaceInspector';
import type { SurfaceConsoleEntry } from '@/lib/browser/remoteSurfaceInspectorProtocol';
import { RemoteBrowserConsoleOutput, type ConsoleEvaluation } from './RemoteBrowserConsoleOutput';
import { remoteInspectorErrorKeys } from './remoteBrowserInspectorMessages';

type Props = {
  readonly inspector: Pick<RemoteSurfaceInspector, 'evaluate'>;
  readonly entries: readonly SurfaceConsoleEntry[];
  readonly captureId: string | null;
  readonly filter: string;
  readonly active: boolean;
  readonly clearRevision: number;
};

export function RemoteBrowserConsole({ inspector, entries, captureId, filter, active, clearRevision }: Props) {
  const { t } = useI18n();
  const [expression, setExpression] = React.useState('');
  const [history, setHistory] = React.useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState<number | null>(null);
  const [evaluations, setEvaluations] = React.useState<readonly ConsoleEvaluation[]>([]);
  const [running, setRunning] = React.useState(false);
  const generation = React.useRef(0);
  const sequence = React.useRef(0);
  const pending = React.useRef(false);
  const draft = React.useRef('');
  const input = React.useRef<HTMLTextAreaElement>(null);
  const oversized = expression.length > 16_000;

  React.useLayoutEffect(() => {
    generation.current += 1;
    pending.current = false;
    setRunning(false);
    setExpression('');
    setHistory([]);
    setHistoryIndex(null);
    setEvaluations([]);
    draft.current = '';
    return () => { generation.current += 1; };
  }, [captureId, inspector]);
  React.useLayoutEffect(() => { setEvaluations([]); }, [clearRevision]);

  const run = async () => {
    if (!captureId || pending.current || !expression.trim() || oversized) return;
    const currentGeneration = generation.current;
    const id = ++sequence.current;
    const afterEntryId = entries.at(-1)?.id ?? null;
    pending.current = true;
    setRunning(true);
    setHistory((previous) => [...previous, expression].slice(-50));
    setHistoryIndex(null);
    setEvaluations((previous) => [...previous, { id, expression, afterEntryId, phase: 'running' } satisfies ConsoleEvaluation].slice(-50));
    setExpression('');
    draft.current = '';
    try {
      const result = await inspector.evaluate(expression);
      if (generation.current !== currentGeneration) return;
      setEvaluations((previous) => previous.map((entry) => entry.id === id ? { id, expression, afterEntryId, phase: 'complete', result } : entry));
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      const errorKey = error instanceof RemoteSurfaceInspectorError
        ? remoteInspectorErrorKeys[error.code] : 'contextPanel.browser.remote.inspector.errorEvaluation';
      setEvaluations((previous) => errorKey
        ? previous.map((entry) => entry.id === id ? { id, expression, afterEntryId, phase: 'failed', errorKey } : entry)
        : previous.filter((entry) => entry.id !== id));
    } finally {
      if (generation.current === currentGeneration) { pending.current = false; setRunning(false); }
    }
  };

  const selectHistory = (direction: -1 | 1) => {
    if (!history.length) return;
    if (historyIndex === null) {
      if (direction === 1) return;
      draft.current = expression;
    }
    const next = (historyIndex ?? history.length) + direction;
    if (next < 0) return;
    setHistoryIndex(next >= history.length ? null : next);
    setExpression(next >= history.length ? draft.current : history[next]);
    input.current?.focus({ preventScroll: true });
  };

  if (!active) return null;
  return <div className="flex min-h-0 flex-1 flex-col">
    <RemoteBrowserConsoleOutput entries={entries} evaluations={evaluations} filter={filter} />
    <div className="shrink-0 space-y-1 border-t border-border p-2">
      <Textarea ref={input} simple rows={2} value={expression} disabled={!captureId}
        outerClassName="rounded-lg bg-[var(--surface-elevated)] ring-1 ring-inset ring-border/60"
        className="min-h-12 max-h-32 font-mono" aria-invalid={oversized}
        aria-label={t('contextPanel.browser.remote.inspector.expressionAria')}
        placeholder={t('contextPanel.browser.remote.inspector.expressionPlaceholder')}
        onChange={(event) => { setExpression(event.currentTarget.value); setHistoryIndex(null); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void run();
          }
        }} />
      {oversized ? <p role="alert" className="typography-micro text-[var(--status-error)]">{t('contextPanel.browser.remote.inspector.errorInvalid')}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" disabled={!history.length || historyIndex === 0}
            aria-label={t('contextPanel.browser.remote.inspector.previousCommand')} onClick={() => selectHistory(-1)}>
            <Icon name="arrow-up-s" className="size-4" />
          </Button>
          <Button variant="ghost" size="xs" disabled={historyIndex === null}
            aria-label={t('contextPanel.browser.remote.inspector.nextCommand')} onClick={() => selectHistory(1)}>
            <Icon name="arrow-down-s" className="size-4" />
          </Button>
        </div>
        <Button size="xs" disabled={running || !captureId || !expression.trim() || oversized} onClick={() => void run()}>
          <Icon name="play" className="size-3.5" />{t(running ? 'contextPanel.browser.remote.inspector.running' : 'contextPanel.browser.remote.inspector.run')}
        </Button>
      </div>
      <p className="typography-micro text-muted-foreground">{t('contextPanel.browser.remote.inspector.shortcutHint')}</p>
    </div>
  </div>;
}
