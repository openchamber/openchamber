import type { SurfaceInspectorRequestDetails, SurfaceNetworkEntry } from '@/lib/browser/remoteSurfaceInspectorProtocol';
import { useI18n } from '@/lib/i18n';

type Props = {
  readonly entry: SurfaceNetworkEntry;
  readonly details: SurfaceInspectorRequestDetails | null;
};

const stateLabels = {
  pending: 'contextPanel.browser.remote.inspector.network.pending',
  complete: 'contextPanel.browser.remote.inspector.network.complete',
  failed: 'contextPanel.browser.remote.inspector.network.failed',
} as const;
const bodyLabels = {
  'not-requested': 'contextPanel.browser.remote.inspector.network.bodiesNotRequested',
  available: null,
  unavailable: 'contextPanel.browser.remote.inspector.network.bodiesUnavailable',
  unsupported: 'contextPanel.browser.remote.inspector.network.bodiesUnsupported',
} as const;

export function RemoteBrowserRequestDetails({ entry, details }: Props) {
  const { t } = useI18n();
  const unknown = t('contextPanel.browser.remote.inspector.network.unknown');
  const metadata = [
    ['contextPanel.browser.remote.inspector.network.method', entry.method],
    ['contextPanel.browser.remote.inspector.network.url', entry.url],
    ['contextPanel.browser.remote.inspector.network.status', entry.status === null ? unknown : `${entry.status} ${entry.statusText}`.trim()],
    ['contextPanel.browser.remote.inspector.network.state', t(stateLabels[entry.state])],
    ['contextPanel.browser.remote.inspector.network.duration', entry.durationMs === null ? unknown : `${Math.round(entry.durationMs)} ms`],
    ['contextPanel.browser.remote.inspector.network.size', entry.encodedBytes === null ? unknown : `${entry.encodedBytes} B`],
    ['contextPanel.browser.remote.inspector.network.resourceType', entry.resourceType || unknown],
    ['contextPanel.browser.remote.inspector.network.mimeType', entry.mimeType || unknown],
    ['contextPanel.browser.remote.inspector.network.cached', t(entry.fromCache ? 'contextPanel.browser.remote.inspector.network.yes' : 'contextPanel.browser.remote.inspector.network.no')],
  ] as const;
  const bodyLabel = details ? bodyLabels[details.bodyState] : null;

  return <div className="min-w-0 space-y-3 typography-meta text-foreground">
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {metadata.map(([label, value]) => <div key={label} className="contents">
        <dt className="text-muted-foreground">{t(label)}</dt>
        <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd>
      </div>)}
      {entry.failureText ? <>
        <dt className="text-muted-foreground">{t('contextPanel.browser.remote.inspector.network.failure')}</dt>
        <dd className="min-w-0 whitespace-pre-wrap text-[var(--status-error)] [overflow-wrap:anywhere]">{entry.failureText}</dd>
      </> : null}
    </dl>
    {details ? <>
      {([
        ['contextPanel.browser.remote.inspector.network.requestHeaders', details.requestHeaders],
        ['contextPanel.browser.remote.inspector.network.responseHeaders', details.responseHeaders],
      ] as const).map(([label, headers]) => <section key={label} className="min-w-0 space-y-1">
        <h4 className="typography-ui-label">{t(label)}</h4>
        <pre className="min-w-0 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">{headers.length
          ? headers.map(({ name, value }) => `${name}: ${value}`).join('\n')
          : t('contextPanel.browser.remote.inspector.network.noHeaders')}</pre>
      </section>)}
      {bodyLabel ? <p className="text-muted-foreground">{t(bodyLabel)}</p> : null}
      {details.bodyState !== 'not-requested' ? ([
        ['contextPanel.browser.remote.inspector.network.requestBody', details.requestBody],
        ['contextPanel.browser.remote.inspector.network.responseBody', details.responseBody],
      ] as const).map(([label, body]) => <section key={label} className="min-w-0 space-y-1">
        <h4 className="typography-ui-label">{t(label)}</h4>
        <pre className="min-w-0 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">{body ?? t('contextPanel.browser.remote.inspector.network.noBody')}</pre>
      </section>) : null}
      {details.truncated ? <p className="text-[var(--status-warning)]">{t('contextPanel.browser.remote.inspector.network.truncated')}</p> : null}
    </> : null}
  </div>;
}
