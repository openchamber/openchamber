import React from 'react';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { readAssetBlob, runtimeAssetsNeedFetch } from '@/lib/runtime-asset';
import { MAX_OPEN_FILE_BYTES } from '@/lib/fileOpenLimits';


type RawAssetRequest = { runtime: string; path: string; directory: string; revision: string; outsideWorkspace: boolean };

type RawAssetUrl = {
  src: string;
  loading: boolean;
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
  const needsFetch = runtimeAssetsNeedFetch();
  const key = path ? JSON.stringify([runtime, path, directory, revision, outsideWorkspace]) : '';
  const [held, setHeld] = React.useState<{ key: string; url: string } | null>(null);

  const mint = React.useCallback(async (): Promise<string> => {
    await refreshUrlToken(getRuntimeApiBaseUrl());
    return rawAssetUrl({ path, directory, outsideWorkspace });
  }, [path, directory, outsideWorkspace, refreshUrlToken]);

  React.useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const load = async () => {
      try {
        let url: string;
        if (needsFetch) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
          const response = await runtimeFetch('/api/fs/raw', {
            query: { path, directory: directory || undefined, allowOutsideWorkspace: outsideWorkspace ? 'true' : undefined },
            signal,
          });
          if (!response.ok) throw new Error(errorFallback);
          const blob = await readAssetBlob(response, MAX_OPEN_FILE_BYTES, signal);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          url = objectUrl;
        } else {
          url = await mint();
        }
        if (cancelled) return;
        setHeld({ key, url });
        reportError(null);
      } catch (error) {
        if (cancelled) return;
        reportError(needsFetch ? errorFallback : error instanceof Error ? error.message : errorFallback);
        setHeld({ key, url: needsFetch ? '' : rawAssetUrl({ path, directory, outsideWorkspace }) });
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, mint, reportError, errorFallback, path, directory, outsideWorkspace, needsFetch]);

  const renew = React.useCallback(async (): Promise<string> => {
    if (needsFetch) return held?.key === key ? held.url : '';
    const url = await mint();
    setHeld((current) => (current?.key === key ? { key, url } : current));
    return url;
  }, [key, mint, needsFetch, held]);

  const src = key && held?.key === key ? held.url : '';
  return { src, loading: Boolean(key) && held?.key !== key, renew };
};
