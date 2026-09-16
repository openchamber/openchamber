import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { loadRelayGuestDocument } from './relay-document';

/**
 * Direct frames use a short-lived guest-scoped URL. Relay frames fetch their
 * HTML and static resources over authenticated runtime HTTP and use srcDoc;
 * browser-owned iframe requests cannot travel through the JS tunnel client.
 * Neither representation contains the runtime's bearer credential.
 */
export type GuestFrameUrl =
  | { kind: 'url'; url: string; expiresAt: number }
  | { kind: 'document'; html: string };

export const resolveGuestFrameUrl = async (guestId: string, entry: string, signal?: AbortSignal): Promise<GuestFrameUrl> => {
  const runtimeKey = getRuntimeKey();
  const relay = getActiveRelayTunnel();
  if (relay) {
    const html = await loadRelayGuestDocument(guestId, entry, (path) => {
      if (getRuntimeKey() !== runtimeKey || getActiveRelayTunnel() !== relay || signal?.aborted) {
        throw new DOMException('Extension frame owner changed', 'AbortError');
      }
      return runtimeFetch(path, { signal });
    });
    if (getRuntimeKey() !== runtimeKey || getActiveRelayTunnel() !== relay || signal?.aborted) {
      throw new DOMException('Extension frame owner changed', 'AbortError');
    }
    return { kind: 'document', html };
  }
  const { token, expiresAt } = await mintGuestFrameUrlAuthToken(guestId);
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while authorizing extension frame');
  return {
    kind: 'url',
    url: getRuntimeUrlResolver().assetWithUrlToken(`/api/guests/${guestId}/${entry}`, token, { oc_ui: 'issue-page' }),
    expiresAt,
  };
};
