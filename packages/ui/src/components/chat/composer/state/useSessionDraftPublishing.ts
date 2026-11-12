/**
 * Keeps the open new-session draft in the server's shared drafts, so it shows
 * in the sidebar once the user leaves it, here and on their other devices.
 *
 * The composer owns the text (`useComposerDraft`); this mirrors it, with its
 * attachments, a moment after the user stops typing, and at once when the
 * composer leaves the draft. A draft the user emptied is discarded: a draft
 * with nothing in it is no row. Sending removes it (`sendMessage`).
 */

import React from 'react';
import { workDraftIdOfComposerKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { SessionDraftTooLargeError, useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useInputStore } from '@/sync/input-store';

const PUBLISH_DEBOUNCE_MS = 700;

type Snapshot = {
  draftId: string;
  directory: string;
  projectId: string | null;
  text: string;
  mentions: string[];
  attachments: readonly AttachedFile[];
};

const signatureOf = (snapshot: Snapshot): string => JSON.stringify([
  snapshot.directory,
  snapshot.projectId,
  snapshot.text,
  snapshot.mentions,
  snapshot.attachments.map((file) => file.id),
]);

const hasContent = (snapshot: Snapshot): boolean => Boolean(snapshot.text.trim()) || snapshot.attachments.length > 0;

/**
 * `hadContent`: this composer last published the draft with something in it.
 * Only then does an empty composer discard it: a draft reopened from the
 * sidebar shows empty until its text is restored, which must not remove it.
 */
const publish = (snapshot: Snapshot, hadContent: boolean, onTooLarge: () => void): void => {
  const drafts = useSessionDraftsStore.getState();
  if (!hasContent(snapshot)) {
    if (hadContent) void drafts.discard(snapshot.draftId).catch(() => undefined);
    return;
  }
  // A failed write leaves the draft in this device's composer, where it was
  // typed, and reopening it here keeps that copy; the next change tries again.
  void drafts.save(snapshot.draftId, snapshot).catch((error) => {
    if (error instanceof SessionDraftTooLargeError) onTooLarge();
  });
};

export function useSessionDraftPublishing(options: {
  /** The composer's draft; only a new session's own draft (`draft:<id>`) is published. */
  identity: ChatDraftIdentity | null;
  message: string;
  confirmedMentionsRef: React.RefObject<Set<string>>;
  projectId: string | null;
  enabled: boolean;
}): void {
  const { identity, message, confirmedMentionsRef, projectId, enabled } = options;
  const { t } = useI18n();
  const tRef = React.useRef(t);
  React.useEffect(() => {
    tRef.current = t;
  }, [t]);
  const attachments = useInputStore((state) => state.attachedFiles);
  const draftId = enabled ? workDraftIdOfComposerKey(identity?.sessionId) : null;
  const directory = identity?.directory ?? null;
  const pendingRef = React.useRef<{ snapshot: Snapshot; timer: ReturnType<typeof setTimeout> } | null>(null);
  const lastSignatureRef = React.useRef(new Map<string, string>());
  const hadContentRef = React.useRef(new Map<string, boolean>());
  // Said once per draft: the next saves fail the same way.
  const warnedTooLargeRef = React.useRef(new Set<string>());

  const flush = React.useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
    const { snapshot } = pending;
    const signature = signatureOf(snapshot);
    if (lastSignatureRef.current.get(snapshot.draftId) === signature) return;
    lastSignatureRef.current.set(snapshot.draftId, signature);
    publish(snapshot, hadContentRef.current.get(snapshot.draftId) === true, () => {
      if (warnedTooLargeRef.current.has(snapshot.draftId)) return;
      warnedTooLargeRef.current.add(snapshot.draftId);
      toast.info(tRef.current('sessions.sidebar.draft.tooLarge'));
    });
    hadContentRef.current.set(snapshot.draftId, hasContent(snapshot));
  }, []);

  React.useEffect(() => {
    if (!draftId || !directory) return;
    const mentions = [...confirmedMentionsRef.current].filter((mention) => message.includes(`@${mention}`));
    const snapshot: Snapshot = { draftId, directory, projectId, text: message, mentions, attachments };
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    pendingRef.current = { snapshot, timer: setTimeout(flush, PUBLISH_DEBOUNCE_MS) };
  }, [attachments, confirmedMentionsRef, directory, draftId, flush, message, projectId]);

  // Leaving the draft (another session, another draft, the page going away)
  // is when it becomes a row, so what is pending goes out now. Sending it
  // leaves it too; the store then drops the late save (`discard` with `final`).
  React.useEffect(() => flush, [draftId, flush]);
  // A project draft switched to a new Chat takes its text along; the draft it
  // left behind would list the same text twice, so it goes.
  const previousDraftIdRef = React.useRef<string | null>(draftId);
  React.useEffect(() => {
    const previous = previousDraftIdRef.current;
    previousDraftIdRef.current = draftId;
    if (previous && !draftId && enabled && hadContentRef.current.get(previous)) {
      hadContentRef.current.delete(previous);
      lastSignatureRef.current.delete(previous);
      void useSessionDraftsStore.getState().discard(previous).catch(() => undefined);
    }
  }, [draftId, enabled]);
  React.useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);
}
