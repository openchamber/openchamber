import { z } from 'zod';

import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isAmbiguousTransportFailure } from '@/lib/relay/transport-error';
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

/**
 * Documents read over the relay, by what the frame's key names (runtime,
 * package revision, grants). A panel loads once, but a chat with several
 * blocks of one extension would read the whole package through the tunnel for
 * each, again on every scroll back. A document can be tens of megabytes, so
 * the bound that matters on a phone is their size, not their number.
 */
const relayDocuments = new Map<string, string>();
const RELAY_DOCUMENTS_MAX = 16;
const RELAY_DOCUMENTS_MAX_CHARS = 32_000_000;

const keepRelayDocument = (key: string, html: string): void => {
  if (html.length > RELAY_DOCUMENTS_MAX_CHARS) return;
  relayDocuments.delete(key);
  relayDocuments.set(key, html);
  let chars = 0;
  for (const kept of relayDocuments.values()) chars += kept.length;
  for (const [oldest, kept] of relayDocuments) {
    if (relayDocuments.size <= RELAY_DOCUMENTS_MAX && chars <= RELAY_DOCUMENTS_MAX_CHARS) break;
    relayDocuments.delete(oldest);
    chars -= kept.length;
  }
};

type RelayDocumentRead = { promise: Promise<string>; abort: AbortController; waiting: number };

/** Reads under way, so frames that appear together share one trip through the tunnel. */
const relayReads = new Map<string, RelayDocumentRead>();

/** One frame going away never cancels a read another frame waits for; the last one does. */
const joinRelayRead = (key: string, start: (signal: AbortSignal) => Promise<string>, signal?: AbortSignal): Promise<string> => {
  let read = relayReads.get(key);
  if (!read) {
    const abort = new AbortController();
    const started: RelayDocumentRead = {
      abort,
      waiting: 0,
      promise: start(abort.signal).finally(() => {
        if (relayReads.get(key) === started) relayReads.delete(key);
      }),
    };
    relayReads.set(key, started);
    read = started;
  }
  const joined = read;
  joined.waiting += 1;
  return new Promise((resolve, reject) => {
    const leave = () => {
      joined.waiting -= 1;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      leave();
      if (joined.waiting === 0) {
        joined.abort.abort();
        if (relayReads.get(key) === joined) relayReads.delete(key);
      }
      reject(new DOMException('Extension frame owner changed', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    joined.promise.then(resolve, reject).finally(() => {
      if (!signal?.aborted) leave();
    });
  });
};

/** Past this a load counts as failed and the pane offers another try; a read over the relay can be slow. */
export const FRAME_LOAD_TIMEOUT_MS = 60_000;

export const resolveGuestFrameUrl = async (
  guestId: string,
  entry: string,
  signal?: AbortSignal,
  origins: readonly string[] = [],
  documentKey?: string,
): Promise<GuestFrameUrl> => {
  const runtimeKey = getRuntimeKey();
  const relay = getActiveRelayTunnel();
  if (relay) {
    const kept = documentKey ? relayDocuments.get(documentKey) : undefined;
    if (kept) return { kind: 'document', html: kept };
    const read = async (readSignal?: AbortSignal): Promise<string> => {
      const assertOwner = () => {
        if (getRuntimeKey() !== runtimeKey || getActiveRelayTunnel() !== relay || readSignal?.aborted) {
          throw new DOMException('Extension frame owner changed', 'AbortError');
        }
      };
      const load = () => loadRelayGuestDocument(guestId, entry, (path) => {
        assertOwner();
        return runtimeFetch(path, { signal: readSignal });
      }, origins);
      // A tunnel that reconnects mid-read loses its streams. Every request here
      // is a GET, and the next one waits for the channel, so one more read is safe.
      let html: string;
      try {
        html = await load();
      } catch (error) {
        if (!isAmbiguousTransportFailure(error)) throw error;
        assertOwner();
        html = await load();
      }
      assertOwner();
      if (documentKey) keepRelayDocument(documentKey, html);
      return html;
    };
    const html = documentKey ? await joinRelayRead(documentKey, read, signal) : await read(signal);
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
