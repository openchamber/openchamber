import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { inlineRelayHtmlDocument } from '@/lib/relay/inline-document';

const PREVIEW_DOCUMENT_ORIGIN = 'https://preview.invalid';

const FRAGMENT_NAVIGATION_SCRIPT = `(function () {
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var link = target.closest('a[href^="#"], area[href^="#"]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href || href[0] !== '#') return;
    event.preventDefault();
    var id = href.slice(1);
    if (!id || id.toLowerCase() === 'top') {
      window.scrollTo(0, 0);
      return;
    }
    var decoded = id;
    try { decoded = decodeURIComponent(id); } catch (_) {}
    var el = document.getElementById(decoded) || document.getElementById(id) || document.getElementsByName(decoded)[0] || document.getElementsByName(id)[0];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView();
  });
})();`;

type HtmlPreviewRequest = {
  runtime?: string;
  relayActive?: boolean;
  path: string;
  directory: string;
  revision: string;
  outsideWorkspace: boolean;
  inlineDocument?: boolean;
};

type HtmlPreviewUrlState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; kind: 'url'; url: string; pageKey: string }
  | { status: 'ready'; kind: 'document'; html: string; pageKey: string }
  | { status: 'error'; message: string };

type MintHtmlPreviewGrant = (request: HtmlPreviewRequest, signal: AbortSignal) => Promise<string>;
type LoadHtmlPreviewDocument = (grant: string, pagePath: string, signal: AbortSignal, beforeFetch?: () => void) => Promise<string>;

const previewGrantSchema = z.object({ grant: z.string().min(1) });

const encodePreviewPath = (pagePath: string): string =>
  pagePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');

export const mintHtmlPreviewGrant = async (
  request: HtmlPreviewRequest,
  signal: AbortSignal,
  fetcher: typeof runtimeFetch = runtimeFetch,
): Promise<string> => {
  const response = await fetcher('/api/fs/preview', {
    method: 'POST',
    signal,
    query: {
      directory: request.directory || undefined,
      allowOutsideWorkspace: request.outsideWorkspace ? 'true' : undefined,
    },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: request.path }),
  });
  if (!response.ok) {
    throw new Error(`Preview grant request failed (${response.status})`);
  }
  const parsed = previewGrantSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error('Preview grant response was invalid');
  }
  return parsed.data.grant;
};

export const htmlPreviewUrl = (grant: string, pagePath: string): string => {
  const encoded = encodePreviewPath(pagePath);
  const absolute = encoded.startsWith('/') ? encoded : `/${encoded}`;
  return getRuntimeUrlResolver().api(`/api/fs/preview/${encodeURIComponent(grant)}${absolute}`);
};

export const loadHtmlPreviewDocument = async (
  grant: string,
  pagePath: string,
  signal: AbortSignal,
  beforeFetch?: () => void,
  fetcher: typeof runtimeFetch = runtimeFetch,
): Promise<string> => inlineRelayHtmlDocument({
  origin: PREVIEW_DOCUMENT_ORIGIN,
  prefix: `/api/fs/preview/${encodeURIComponent(grant)}/`,
  entry: encodePreviewPath(pagePath).replace(/^\/+/, ''),
  load: (path) => {
    beforeFetch?.();
    return fetcher(path, { signal, cache: 'no-store', query: { inline: '1' } });
  },
  headScript: FRAGMENT_NAVIGATION_SCRIPT,
  strictSubresources: false,
  signal,
});

export const useHtmlPreviewUrl = (
  request: HtmlPreviewRequest | null,
  errorFallback: string,
  mint: MintHtmlPreviewGrant = mintHtmlPreviewGrant,
  loadDocument: LoadHtmlPreviewDocument = loadHtmlPreviewDocument,
): HtmlPreviewUrlState => {
  const [state, setState] = React.useState<HtmlPreviewUrlState>({ status: 'idle' });
  const runtime = request?.runtime ?? '';
  const relayActive = request?.relayActive ?? false;
  const path = request?.path ?? '';
  const directory = request?.directory ?? '';
  const revision = request?.revision ?? '';
  const outsideWorkspace = request?.outsideWorkspace ?? false;
  const inlineDocument = request?.inlineDocument ?? false;

  React.useEffect(() => {
    if (!path) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    const ownerRuntime = getRuntimeKey();
    const ownerRelay = getActiveRelayTunnel();
    const isStale = () => controller.signal.aborted || getRuntimeKey() !== ownerRuntime || getActiveRelayTunnel() !== ownerRelay;
    const assertOwner = () => {
      if (isStale()) throw new DOMException('Preview owner changed', 'AbortError');
    };
    setState({ status: 'loading' });
    const load = async () => {
      try {
        const grant = await mint({ runtime, relayActive, path, directory, revision, outsideWorkspace, inlineDocument }, controller.signal);
        assertOwner();
        if (inlineDocument) {
          const html = await loadDocument(grant, path, controller.signal, assertOwner);
          assertOwner();
          setState({ status: 'ready', kind: 'document', html, pageKey: `${runtime}:${path}#${revision}` });
          return;
        }
        const url = htmlPreviewUrl(grant, path);
        assertOwner();
        setState({ status: 'ready', kind: 'url', url, pageKey: url });
      } catch (error) {
        if (isStale()) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : errorFallback });
      }
    };
    void load();
    return () => controller.abort();
  }, [runtime, relayActive, path, directory, revision, outsideWorkspace, inlineDocument, errorFallback, mint, loadDocument]);

  return state;
};
