import React from 'react';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

/**
 * A PDF, audio, video or font preview is a URL the browser owns, so it carries
 * the short-lived scoped URL token. The URL is made once per file and then
 * held: a new URL reloads the document, which put a PDF back on page 1 and
 * stopped playback every time the shared token rotated. The server checks the
 * token when a request starts, so a held URL keeps loading its document; a
 * player that needs another byte range after the token expired asks `renew`
 * for a URL with a fresh token and resumes where it was.
 */

// `revision` changes when the file's content does and `runtime` when the app
// switches to another server; either gets a fresh URL and a fresh document.
type RawAssetRequest = { runtime: string; path: string; directory: string; revision: string; outsideWorkspace: boolean };

type RawAssetUrl = {
  /** Empty while the first URL is being made. */
  src: string;
  loading: boolean;
  /** Makes a URL with a valid token for the same file and shows it. */
  renew: () => Promise<string>;
};

type RefreshUrlToken = (apiBaseUrl: string) => Promise<string>;

const rawAssetUrl = (request: Pick<RawAssetRequest, 'path' | 'directory' | 'outsideWorkspace'>): string => (
  getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
    path: request.path,
    allowOutsideWorkspace: request.outsideWorkspace ? 'true' : undefined,
    directory: request.directory || undefined,
  })
);

export const useRawAssetUrl = (
  request: RawAssetRequest | null,
  reportError: (message: string | null) => void,
  errorFallback: string,
  refreshUrlToken: RefreshUrlToken = refreshRuntimeUrlAuthToken,
): RawAssetUrl => {
  const runtime = request?.runtime ?? '';
  const path = request?.path ?? '';
  const directory = request?.directory ?? '';
  const revision = request?.revision ?? '';
  const outsideWorkspace = request?.outsideWorkspace ?? false;
  const key = path ? JSON.stringify([runtime, path, directory, revision, outsideWorkspace]) : '';
  const [held, setHeld] = React.useState<{ key: string; url: string } | null>(null);

  const mint = React.useCallback(async (): Promise<string> => {
    await refreshUrlToken(getRuntimeApiBaseUrl());
    return rawAssetUrl({ path, directory, outsideWorkspace });
  }, [path, directory, outsideWorkspace, refreshUrlToken]);

  React.useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const load = async () => {
      try {
        const url = await mint();
        if (cancelled) return;
        setHeld({ key, url });
        reportError(null);
      } catch (error) {
        if (cancelled) return;
        reportError(error instanceof Error ? error.message : errorFallback);
        setHeld({ key, url: rawAssetUrl({ path, directory, outsideWorkspace }) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [key, mint, reportError, errorFallback, path, directory, outsideWorkspace]);

  const renew = React.useCallback(async (): Promise<string> => {
    const url = await mint();
    setHeld((current) => (current?.key === key ? { key, url } : current));
    return url;
  }, [key, mint]);

  const src = key && held?.key === key ? held.url : '';
  return { src, loading: Boolean(key) && !src, renew };
};
