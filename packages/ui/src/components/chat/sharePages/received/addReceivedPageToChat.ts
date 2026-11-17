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

export const sharedPageChipFor = (page: Pick<ReceivedPage, 'receivedId' | 'host' | 'title' | 'opened'>): SharedPageReference => ({
  kind: 'shared-page',
  shareKey: page.receivedId,
  receivedId: page.receivedId,
  host: page.host,
  title: page.title,
  opened: page.opened,
  contextText: unopenedPageAgentText(page.host),
});

export const holdsSharedPage = (references: readonly ComposerReference[], receivedId: string): boolean => (
  references.some((reference) => reference.kind === 'shared-page' && reference.receivedId === receivedId)
);

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
