import { registerReceivedPage, type ReceivedPage } from '@/lib/received-pages/api';
import type { FoundShareLink } from '@/lib/received-pages/link';

import type { ComposerReference } from '../../composer/composerReferences';

import { unopenedPageAgentText } from './pageText';

type SharedPageReference = Extract<ComposerReference, { kind: 'shared-page' }>;

const registrations = new Map<string, Promise<ReceivedPage>>();

export function takeShareLink(link: FoundShareLink): SharedPageReference {
  const shareKey = `${link.host}/${link.shareId}`;
  const registration = registerReceivedPage(link.url);
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

export function readShareLinkRegistration(shareKey: string): Promise<ReceivedPage> | null {
  return registrations.get(shareKey) ?? null;
}

export async function withRegisteredSharedPages(references: ComposerReference[]): Promise<ComposerReference[]> {
  return Promise.all(references.map(async (reference) => {
    if (reference.kind !== 'shared-page' || reference.receivedId) return reference;
    const registered = await readShareLinkRegistration(reference.shareKey)?.catch(() => null);
    return registered ? { ...reference, receivedId: registered.receivedId } : reference;
  }));
}
