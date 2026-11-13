import { z } from 'zod';

import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { loadRelayGuestDocument } from './relay-document';

/**
 * Direct frames load their package from `/api/guest-files/<grant>/…`: the
 * grant in the path is the frame's only credential, so the page's relative
 * URLs (scripts, styles, its own `fetch`) keep it, and the frame never needs
 * the session a sign-in proxy in front of the server would ask for. A server
 * that predates grants gets the short-lived guest-scoped query token instead.
 * Relay frames fetch their HTML and static resources over authenticated
 * runtime HTTP and use srcDoc; browser-owned iframe requests cannot travel
 * through the JS tunnel client. No representation contains the runtime's
 * bearer credential.
 */
export type GuestFrameUrl =
  | { kind: 'url'; url: string; expiresAt: number }
  | { kind: 'document'; html: string };

const frameGrantSchema = z.object({ grant: z.string().min(1), expiresAt: z.number() });

/** The frame's grant, or null when the server predates grants. */
const mintGuestFrameGrant = async (guestId: string, signal?: AbortSignal): Promise<z.infer<typeof frameGrantSchema> | null> => {
  const response = await runtimeFetch(`/api/guests/${encodeURIComponent(guestId)}/frame-grant`, { method: 'POST', signal });
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw new Error(`Extension frame grant failed (HTTP ${response.status})`);
  const parsed = frameGrantSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Extension frame grant response was invalid');
  return parsed.data;
};

const packagePath = (entry: string): string => entry.split('/').map((segment) => encodeURIComponent(segment)).join('/');

export const resolveGuestFrameUrl = async (
  guestId: string,
  entry: string,
  signal?: AbortSignal,
  origins: readonly string[] = [],
): Promise<GuestFrameUrl> => {
  const runtimeKey = getRuntimeKey();
  const relay = getActiveRelayTunnel();
  if (relay) {
    const html = await loadRelayGuestDocument(guestId, entry, (path) => {
      if (getRuntimeKey() !== runtimeKey || getActiveRelayTunnel() !== relay || signal?.aborted) {
        throw new DOMException('Extension frame owner changed', 'AbortError');
      }
      return runtimeFetch(path, { signal });
    }, origins);
    if (getRuntimeKey() !== runtimeKey || getActiveRelayTunnel() !== relay || signal?.aborted) {
      throw new DOMException('Extension frame owner changed', 'AbortError');
    }
    return { kind: 'document', html };
  }
  const grant = await mintGuestFrameGrant(guestId, signal);
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while authorizing extension frame');
  if (grant) {
    return {
      kind: 'url',
      url: getRuntimeUrlResolver().api(`/api/guest-files/${encodeURIComponent(grant.grant)}/${packagePath(entry)}`),
      expiresAt: grant.expiresAt,
    };
  }
  const { token, expiresAt } = await mintGuestFrameUrlAuthToken(guestId);
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while authorizing extension frame');
  return {
    kind: 'url',
    url: getRuntimeUrlResolver().assetWithUrlToken(`/api/guests/${guestId}/${entry}`, token, { oc_ui: 'issue-page' }),
    expiresAt,
  };
};
