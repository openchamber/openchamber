import React from 'react';
import { Button } from '@/components/ui/button';
import { RemoteSurfaceInspectorError, type RemoteSurfaceInspector } from '@/lib/browser/remoteSurfaceInspector';
import type { SurfaceInspectorErrorCode, SurfaceInspectorRequestDetails, SurfaceNetworkEntry } from '@/lib/browser/remoteSurfaceInspectorProtocol';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { RemoteBrowserRequestDetails } from './RemoteBrowserRequestDetails';

type Props = {
  readonly inspector: Pick<RemoteSurfaceInspector, 'requestDetails'>;
  readonly entries: readonly SurfaceNetworkEntry[];
  readonly captureId: string | null;
  readonly filter: string;
};

type DetailState =
  | { readonly phase: 'loading'; readonly data: SurfaceInspectorRequestDetails | null }
  | { readonly phase: 'ready'; readonly data: SurfaceInspectorRequestDetails }
  | { readonly phase: 'error'; readonly data: SurfaceInspectorRequestDetails | null; readonly message: I18nKey };

const stateLabels = {
  pending: 'contextPanel.browser.remote.inspector.network.pending',
  complete: 'contextPanel.browser.remote.inspector.network.complete',
  failed: 'contextPanel.browser.remote.inspector.network.failed',
} as const;
const detailErrors = {
  UNAVAILABLE: 'contextPanel.browser.remote.inspector.network.failedDetails',
  INVALID_REQUEST: 'contextPanel.browser.remote.inspector.network.failedDetails',
  CAPTURE_GONE: 'contextPanel.browser.remote.inspector.network.captureGone',
  EVALUATION_FAILED: 'contextPanel.browser.remote.inspector.network.failedDetails',
  EVALUATION_TIMEOUT: 'contextPanel.browser.remote.inspector.network.failedDetails',
  REQUEST_GONE: 'contextPanel.browser.remote.inspector.network.requestGone',
  REQUEST_FAILED: 'contextPanel.browser.remote.inspector.network.failedDetails',
  CAPTURE_FAILED: 'contextPanel.browser.remote.inspector.network.failedDetails',
  CANCELLED: 'contextPanel.browser.remote.inspector.network.captureGone',
  TIMEOUT: 'contextPanel.browser.remote.inspector.network.failedDetails',
} satisfies Readonly<Record<SurfaceInspectorErrorCode, I18nKey>>;

export function RemoteBrowserNetwork(props: Props) {
  return <NetworkCapture key={props.captureId} {...props} />;
}

function NetworkCapture({ inspector, entries, captureId, filter }: Props) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<DetailState | null>(null);
  const generation = React.useRef(0);
  const selected = entries.find((entry) => entry.id === selectedId);
  const query = filter.trim().toLocaleLowerCase();
  const visible = entries.filter((entry) => `${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.resourceType}`.toLocaleLowerCase().includes(query));

  React.useEffect(() => {
    generation.current += 1;
    setSelectedId(null);
    setDetail(null);
    return () => { generation.current += 1; };
  }, [inspector]);

  React.useEffect(() => {
    if (selectedId && !selected) {
      generation.current += 1;
      setSelectedId(null);
      setDetail(null);
    }
  }, [selected, selectedId]);

  const load = async (entryId: string, includeBody: boolean) => {
    const revision = ++generation.current;
    const previous = includeBody ? detail?.data ?? null : null;
    setSelectedId(entryId);
    setDetail({ phase: 'loading', data: previous });
    try {
      const data = await inspector.requestDetails(entryId, includeBody);
      if (revision === generation.current) setDetail({ phase: 'ready', data });
    } catch (error) {
      if (revision !== generation.current) return;
      const message = error instanceof RemoteSurfaceInspectorError
        ? detailErrors[error.code] : 'contextPanel.browser.remote.inspector.network.failedDetails';
      setDetail({ phase: 'error', data: previous, message });
    }
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t('contextPanel.browser.remote.inspector.network')}>
      {visible.length ? <ul className="space-y-1">
        {visible.map((entry) => <li key={entry.id}>
          <Button variant="ghost" size="sm" disabled={!captureId}
            aria-pressed={selectedId === entry.id} onClick={() => void load(entry.id, false)}
            className="w-full min-w-0 justify-start font-mono normal-case aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground">
            <span className="shrink-0">{entry.method}</span>
            <span className="min-w-0 flex-1 truncate text-left">{entry.url}</span>
            <span className={entry.state === 'failed' ? 'shrink-0 text-[var(--status-error)]' : 'shrink-0 text-muted-foreground'}>
              {entry.status ?? t(stateLabels[entry.state])}
            </span>
          </Button>
        </li>)}
      </ul> : <p className="typography-meta text-muted-foreground">{t(entries.length
        ? 'contextPanel.browser.remote.inspector.network.noMatches' : 'contextPanel.browser.remote.inspector.network.empty')}</p>}
    </div>
    {selected ? <section className="min-h-0 min-w-0 flex-1 overflow-y-auto border-t border-border p-2"
      aria-label={t('contextPanel.browser.remote.inspector.network.details')}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="typography-ui-label text-foreground">{t('contextPanel.browser.remote.inspector.network.details')}</h3>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" disabled={!detail?.data || detail.phase === 'loading'} onClick={() => void load(selected.id, true)}>
            {t('contextPanel.browser.remote.inspector.network.loadBodies')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { generation.current += 1; setSelectedId(null); setDetail(null); }}>
            {t('contextPanel.browser.remote.inspector.network.closeDetails')}
          </Button>
        </div>
      </div>
      {detail?.phase === 'loading' ? <p role="status" className="mb-2 typography-meta text-muted-foreground">{t('contextPanel.browser.remote.inspector.network.loading')}</p> : null}
      {detail?.phase === 'error' ? <p role="alert" className="mb-2 typography-meta text-[var(--status-error)]">{t(detail.message)}</p> : null}
      <RemoteBrowserRequestDetails entry={selected} details={detail?.data ?? null} />
    </section> : entries.length ? <p className="shrink-0 px-2 pb-2 typography-meta text-muted-foreground">{t('contextPanel.browser.remote.inspector.network.selectRequest')}</p> : null}
  </div>;
}
