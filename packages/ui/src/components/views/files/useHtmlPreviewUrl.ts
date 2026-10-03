import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

/**
 * An HTML preview is untrusted content. It runs in a sandboxed frame without
 * our origin and loads its files from `/api/fs/preview/<grant>/…`, a grant the
 * server mints for this one page. The grant lives in the path so the page's
 * relative URLs keep it; no session credential is ever in a URL the page reads.
 */

type HtmlPreviewRequest = { path: string; directory: string; revision: string };

type HtmlPreviewUrlState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

type MintHtmlPreviewGrant = (request: HtmlPreviewRequest, signal: AbortSignal) => Promise<string>;

const previewGrantSchema = z.object({ grant: z.string().min(1) });

export const mintHtmlPreviewGrant = async (
  request: HtmlPreviewRequest,
  signal: AbortSignal,
  fetcher: typeof runtimeFetch = runtimeFetch,
): Promise<string> => {
  const response = await fetcher('/api/fs/preview', {
    method: 'POST',
    signal,
    query: { directory: request.directory || undefined },
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
  const encoded = pagePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const absolute = encoded.startsWith('/') ? encoded : `/${encoded}`;
  return getRuntimeUrlResolver().api(`/api/fs/preview/${encodeURIComponent(grant)}${absolute}`);
};

export const useHtmlPreviewUrl = (
  request: HtmlPreviewRequest | null,
  errorFallback: string,
  mint: MintHtmlPreviewGrant = mintHtmlPreviewGrant,
): HtmlPreviewUrlState => {
  const [state, setState] = React.useState<HtmlPreviewUrlState>({ status: 'idle' });
  const path = request?.path ?? '';
  const directory = request?.directory ?? '';
  const revision = request?.revision ?? '';

  React.useEffect(() => {
    if (!path) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    const load = async () => {
      try {
        const grant = await mint({ path, directory, revision }, controller.signal);
        if (!controller.signal.aborted) setState({ status: 'ready', url: htmlPreviewUrl(grant, path) });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : errorFallback });
      }
    };
    void load();
    return () => controller.abort();
  }, [path, directory, revision, errorFallback, mint]);

  return state;
};
