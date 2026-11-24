
import { withoutShareLinkKeys } from '@/lib/received-pages/link';
import React from 'react';
import { workDraftIdOfComposerKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { SessionDraftTooLargeError, useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useInputStore } from '@/sync/input-store';
import { useComposerTextEffect, type ComposerText } from './composerText';

const PUBLISH_DEBOUNCE_MS = 700;

type Snapshot = {
  draftId: string;
  directory: string;
  projectId: string | null;
  targetFolderId?: string;
  lead: boolean;
  text: string;
  mentions: string[];
  attachments: readonly AttachedFile[];
};

const signatureOf = (snapshot: Snapshot): string => JSON.stringify([
  snapshot.directory,
  snapshot.projectId,
  snapshot.targetFolderId,
  snapshot.lead,
  snapshot.text,
  snapshot.mentions,
  snapshot.attachments.map((file) => file.id),
]);

const hasContent = (snapshot: Snapshot): boolean => Boolean(snapshot.text.trim()) || snapshot.attachments.length > 0;

const publish = (snapshot: Snapshot, hadContent: boolean, onTooLarge: () => void): void => {
  const drafts = useSessionDraftsStore.getState();
  if (!hasContent(snapshot)) {
    if (hadContent) void drafts.discard(snapshot.draftId).catch(() => undefined);
    return;
  }
  void drafts.save(snapshot.draftId, snapshot).catch((error) => {
    if (error instanceof SessionDraftTooLargeError) onTooLarge();
  });
};

export function useSessionDraftPublishing(options: {
  identity: ChatDraftIdentity | null;
  text: ComposerText;
  confirmedMentionsRef: React.RefObject<Set<string>>;
  projectId: string | null;
  targetFolderId?: string;
  lead: boolean;
  enabled: boolean;
}): void {
  const { identity, text, confirmedMentionsRef, projectId, targetFolderId, lead, enabled } = options;
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

  useComposerTextEffect(text, (message) => {
    if (!draftId || !directory) return;
    const mentions = [...confirmedMentionsRef.current].filter((mention) => message.includes(`@${mention}`));
    const snapshot: Snapshot = { draftId, directory, projectId, targetFolderId, lead, text: withoutShareLinkKeys(message), mentions, attachments };
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    pendingRef.current = { snapshot, timer: setTimeout(flush, PUBLISH_DEBOUNCE_MS) };
  }, [attachments, confirmedMentionsRef, directory, draftId, flush, lead, projectId, targetFolderId]);

  React.useEffect(() => flush, [draftId, flush]);
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
