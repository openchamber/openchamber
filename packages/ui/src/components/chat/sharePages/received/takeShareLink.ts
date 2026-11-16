import { registerReceivedPage, type ReceivedPage } from '@/lib/received-pages/api';
import type { FoundShareLink } from '@/lib/received-pages/link';

import type { ComposerReference } from '../../composer/composerReferences';

import { unopenedPageAgentText } from './pageText';

type SharedPageReference = Extract<ComposerReference, { kind: 'shared-page' }>;

// The server's answer to each link handed over, by chip key. Holding the
// answer, never the link, keeps the key out of the client once it has gone
// to the server; an answer carries no secret, so it is kept for the window's
// life (a chip remounted later still finds it).
const registrations = new Map<string, Promise<ReceivedPage>>();

/**
 * Takes a share link out of the composer: hands it to the server, which keeps
 * its key and reads the share's state, and answers the chip that stands for
 * it until the page is opened. Sent as it is, the chip tells the agent a link
 * was shared and not opened.
 */
export function takeShareLink(link: FoundShareLink): SharedPageReference {
  const shareKey = `${link.host}/${link.shareId}`;
  const registration = registerReceivedPage(link.url);
  // A failure is read by the chip; this copy only keeps it from going unhandled.
  registration.catch(() => undefined);
  registrations.set(shareKey, registration);
  return {
    kind: 'shared-page',
    shareKey,
    receivedId: null,
    host: link.host,
    title: null,
    opened: false,
    contextText: unopenedPageAgentText(link.host),
  };
}

/** The server's answer for a chip still without a `receivedId`; null when this window never took that link. */
export function readShareLinkRegistration(shareKey: string): Promise<ReceivedPage> | null {
  return registrations.get(shareKey) ?? null;
}

/**
 * The references with each page chip still waiting on the server given its
 * id, so a message sent right after a paste names the page. One the server
 * refused stays without an id, and the agent reads it as an unopened link.
 */
export async function withRegisteredSharedPages(references: ComposerReference[]): Promise<ComposerReference[]> {
  return Promise.all(references.map(async (reference) => {
    if (reference.kind !== 'shared-page' || reference.receivedId) return reference;
    const registered = await readShareLinkRegistration(reference.shareKey)?.catch(() => null);
    return registered ? { ...reference, receivedId: registered.receivedId } : reference;
  }));
}
