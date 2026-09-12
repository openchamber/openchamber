import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { SurfaceConsoleEntry, SurfaceInspectorEvaluation } from '@/lib/browser/remoteSurfaceInspectorProtocol';

export type ConsoleEvaluation = {
  readonly id: number;
  readonly expression: string;
  readonly afterEntryId: string | null;
} & (
  | { readonly phase: 'running' }
  | { readonly phase: 'complete'; readonly result: SurfaceInspectorEvaluation }
  | { readonly phase: 'failed'; readonly errorKey: I18nKey }
);

type TranscriptEntry =
  | { readonly kind: 'page'; readonly entry: SurfaceConsoleEntry }
  | { readonly kind: 'evaluation'; readonly entry: ConsoleEvaluation };

function mergeTranscript(entries: readonly SurfaceConsoleEntry[], evaluations: readonly ConsoleEvaluation[]): TranscriptEntry[] {
  const retainedIds = new Set(entries.map((entry) => entry.id));
  const anchored = new Map<string | null, ConsoleEvaluation[]>();
  for (const evaluation of evaluations) {
    const anchor = evaluation.afterEntryId !== null && retainedIds.has(evaluation.afterEntryId) ? evaluation.afterEntryId : null;
    const group = anchored.get(anchor);
    if (group) group.push(evaluation);
    else anchored.set(anchor, [evaluation]);
  }
  // Anchor to observed rows because the remote page and this client can have different clocks.
  const transcript: TranscriptEntry[] = (anchored.get(null) ?? []).map((entry) => ({ kind: 'evaluation', entry }));
  for (const entry of entries) {
    transcript.push({ kind: 'page', entry });
    for (const evaluation of anchored.get(entry.id) ?? []) transcript.push({ kind: 'evaluation', entry: evaluation });
  }
  return transcript;
}

const levelKeys = {
  debug: 'contextPanel.browser.remote.inspector.level.debug',
  info: 'contextPanel.browser.remote.inspector.level.info',
  log: 'contextPanel.browser.remote.inspector.level.log',
  warning: 'contextPanel.browser.remote.inspector.level.warning',
  error: 'contextPanel.browser.remote.inspector.level.error',
} satisfies Record<SurfaceConsoleEntry['level'], I18nKey>;

function EvaluationOutput({ evaluation }: { readonly evaluation: ConsoleEvaluation }) {
  const { t } = useI18n();
  switch (evaluation.phase) {
    case 'running': return <p className="typography-micro text-muted-foreground">{t('contextPanel.browser.remote.inspector.running')}</p>;
    case 'failed': return <p role="alert" className="typography-micro text-[var(--status-error)]">{t(evaluation.errorKey)}</p>;
    case 'complete': return <>
      <pre aria-label={t('contextPanel.browser.remote.inspector.resultAria')}
        className={`whitespace-pre-wrap break-words font-mono typography-micro ${evaluation.result.isError ? 'text-[var(--status-error)]' : 'text-foreground'}`}>
        {evaluation.result.text}
      </pre>
      {evaluation.result.truncated ? <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.remote.inspector.truncated')}</span> : null}
    </>;
    default: return evaluation satisfies never;
  }
}

type Props = {
  readonly entries: readonly SurfaceConsoleEntry[];
  readonly evaluations: readonly ConsoleEvaluation[];
  readonly filter: string;
};

export function RemoteBrowserConsoleOutput({ entries, evaluations, filter }: Props) {
  const { t, locale } = useI18n();
  const query = filter.trim().toLocaleLowerCase(locale);
  const transcript = React.useMemo(() => mergeTranscript(entries, evaluations), [entries, evaluations]);
  const visibleTranscript = query ? transcript.filter((row) => {
    const text = row.kind === 'page' ? `${row.entry.text}\n${row.entry.source}`
      : row.entry.phase === 'complete' ? `${row.entry.expression}\n${row.entry.result.text}` : row.entry.expression;
    return text.toLocaleLowerCase(locale).includes(query);
  }) : transcript;
  const scroller = React.useRef<HTMLDivElement>(null);
  const followTail = React.useRef(true);
  React.useLayoutEffect(() => {
    if (followTail.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries, evaluations, filter]);

  return <div ref={scroller} role="log" aria-label={t('contextPanel.browser.remote.inspector.console')}
    className="min-h-0 flex-1 overflow-auto overscroll-contain"
    onScroll={(event) => { const node = event.currentTarget; followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>
    {!visibleTranscript.length ? <p className="p-3 typography-micro text-muted-foreground">
      {t(query ? 'contextPanel.browser.remote.inspector.filteredEmpty' : 'contextPanel.browser.remote.inspector.emptyConsole')}
    </p> : null}
    {visibleTranscript.map((row) => {
      if (row.kind === 'evaluation') return <div key={`evaluation:${row.entry.id}`} className="border-b border-border/50 px-2 py-1">
        <pre aria-label={t('contextPanel.browser.remote.inspector.commandAria')} className="whitespace-pre-wrap break-words font-mono typography-micro text-muted-foreground">{`> ${row.entry.expression}`}</pre>
        <EvaluationOutput evaluation={row.entry} />
      </div>;
      const entry = row.entry;
      return <div key={`page:${entry.id}`} className="border-b border-border/50 px-2 py-1">
        <div className="flex flex-wrap items-center gap-x-2 typography-micro text-muted-foreground">
          <time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleTimeString(locale)}</time>
          <span className={entry.level === 'error' ? 'text-[var(--status-error)]' : entry.level === 'warning' ? 'text-[var(--status-warning)]' : undefined}>{t(levelKeys[entry.level])}</span>
          {entry.source ? <span className="min-w-0 break-all">{entry.source}{entry.line !== null ? `:${entry.line}` : ''}</span> : null}
          {entry.truncated ? <span>{t('contextPanel.browser.remote.inspector.truncated')}</span> : null}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono typography-micro text-foreground">{entry.text}</pre>
      </div>;
    })}
  </div>;
}
