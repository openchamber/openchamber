import { z } from 'zod';

import { workDraftComposerKey } from '@/lib/chatDraftPersistence';
import type { ReceivedPage } from '@/lib/received-pages/api';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';

import type { ComposerReference } from '../../composer/composerReferences';
import { focusChatInput } from '../../composer/editor/dom';
import { useLinkedReferenceDrafts } from '../../composer/linkedReferenceDrafts';
import { usePendingComposerReferences, type ComposerReferenceHandoff } from '../../composer/pendingComposerReferences';

import { unopenedPageAgentText } from './pageText';

type SharedPageReference = Extract<ComposerReference, { kind: 'shared-page' }>;

/**
 * A page's chip as Add to chat puts it on the composer: the page by its id,
 * no link and no PIN. The agent's copy is rebuilt from the server once the
 * chip mounts (an opened page's source), as for a chip restored from a draft.
 */
export const sharedPageChipFor = (page: Pick<ReceivedPage, 'receivedId' | 'host' | 'title' | 'opened'>): SharedPageReference => ({
  kind: 'shared-page',
  shareKey: page.receivedId,
  receivedId: page.receivedId,
  host: page.host,
  title: page.title,
  opened: page.opened,
  contextText: unopenedPageAgentText(page.host),
});

/** Whether references already hold this page's chip, whichever way it got there. */
export const holdsSharedPage = (references: readonly ComposerReference[], receivedId: string): boolean => (
  references.some((reference) => reference.kind === 'shared-page' && reference.receivedId === receivedId)
);

// A draft identity's key (`getChatDraftIdentityKey`): runtime, folder, composer key.
const draftKeySchema = z.tuple([z.string(), z.string(), z.string().nullable()]);

const composerKeyOf = (draftKey: string): { runtimeKey: string; composerKey: string | null } | null => {
  let parsed;
  try {
    parsed = draftKeySchema.safeParse(JSON.parse(draftKey));
  } catch {
    return null;
  }
  return parsed.success ? { runtimeKey: parsed.data[0], composerKey: parsed.data[2] } : null;
};

/** Whether the composer the handoff targets already has the page, on screen or on its way. */
const composerHolds = (target: ComposerReferenceHandoff, receivedId: string): boolean => {
  const runtimeKey = target.kind === 'draft' ? target.runtimeKey : getRuntimeKey();
  const composerKey = target.kind === 'session' ? target.sessionId : workDraftComposerKey(target.workDraftId);
  for (const [key, references] of useLinkedReferenceDrafts.getState().drafts) {
    const owner = composerKeyOf(key);
    if (owner?.runtimeKey === runtimeKey && owner.composerKey === composerKey && holdsSharedPage(references, receivedId)) return true;
  }
  return usePendingComposerReferences.getState().pending.some((entry) => (
    JSON.stringify(entry.target) === JSON.stringify(target) && holdsSharedPage(entry.references, receivedId)
  ));
};

/**
 * Add to chat: the page's chip goes on the composer of the session (or the
 * new-session draft) the chat shows, through the same handoff the issues
 * board attaches with, and the composer takes focus. A composer that already
 * holds the page only takes focus.
 */
export function addReceivedPageToChat(page: Pick<ReceivedPage, 'receivedId' | 'host' | 'title' | 'opened'>): void {
  const state = useSessionUIStore.getState();
  const draft = state.newSessionDraft;
  const target: ComposerReferenceHandoff | null = draft?.open
    ? (draft.workDraftId ? { kind: 'draft', workDraftId: draft.workDraftId, runtimeKey: getRuntimeKey() } : null)
    : state.currentSessionId ? { kind: 'session', sessionId: state.currentSessionId } : null;
  if (target && !composerHolds(target, page.receivedId)) {
    usePendingComposerReferences.getState().push([sharedPageChipFor(page)], target);
  }
  requestAnimationFrame(() => focusChatInput());
}
