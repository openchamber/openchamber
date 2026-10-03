import React from 'react';

import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useGuestsStore } from './store';

/** Load with current runtime credentials, not an expiring token embedded in a CSS URL. */
export const useGuestIconSource = (src: string): string | undefined => {
  const [runtimeKey, setRuntimeKey] = React.useState(getRuntimeKey);
  const [loaded, setLoaded] = React.useState<{ key: string; url: string } | null>(null);
  const assetPath = React.useMemo(() => {
    try {
      const path = new URL(src, 'https://extension.invalid').pathname;
      return /^\/api\/guests\/[a-z][a-z0-9-]*\/.+\.svg$/i.test(path) ? path : null;
    } catch { return null; }
  }, [src]);
  const guestId = assetPath?.split('/')[3];
  const version = useGuestsStore((state) => state.guests.find((guest) => guest.id === guestId)?.version);
  const relay = getActiveRelayTunnel();
  const key = JSON.stringify([runtimeKey, assetPath, version]);
  React.useEffect(() => subscribeRuntimeEndpointChanged((detail) => setRuntimeKey(detail.runtimeKey)), []);

  React.useEffect(() => {
    if (!assetPath) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const response = await runtimeFetch(assetPath, { signal: abort.signal });
      if (!response.ok) throw new Error('Could not load extension icon');
      const blob = await response.blob();
      if (blob.type.split(';')[0] !== 'image/svg+xml' || blob.size > 2 * 1024 * 1024) {
        throw new Error('Invalid extension icon response');
      }
      if (abort.signal.aborted || getRuntimeKey() !== runtimeKey || getActiveRelayTunnel() !== relay) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ key, url: objectUrl });
    })().catch(() => {
      // The icon component keeps its standard fallback on transport failure.
    });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetPath, key, relay, runtimeKey]);

  return loaded?.key === key ? loaded.url : undefined;
};
