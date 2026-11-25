import React from 'react';

import {
  CHAT_DRAFTS_STORAGE_KEY,
  createChatDraftIdentity,
  getChatDraftIdentityKey,
  readChatDraft,
  writeChatDraft,
  type ChatDraftIdentity,
} from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';

const DRAFT_SAVE_DEBOUNCE_MS = 500;

export type KnowledgeDraftKind = 'note' | 'todo' | 'plan';

export const knowledgeFieldKey = (identity: ChatDraftIdentity | null): string => (
  `knowledge:${identity ? getChatDraftIdentityKey(identity) : ''}`
);

export const knowledgePanelKey = (projectPath: string): string => `knowledge:${getRuntimeKey()}:${projectPath}`;

const mountedDrafts = new Map<string, (change: (text: string) => string) => void>();

export const appendKnowledgeDraft = (identity: ChatDraftIdentity | null, change: (text: string) => string): void => {
  const mounted = mountedDrafts.get(knowledgeFieldKey(identity));
  if (mounted) mounted(change);
  else if (identity) writeChatDraft(identity, change(readChatDraft(identity).text), []);
};

export const useKnowledgeDraft = (projectPath: string, kind: KnowledgeDraftKind) => {
  const identity = React.useMemo(
    () => createChatDraftIdentity(getRuntimeKey(), projectPath, `knowledge:${kind}`),
    [kind, projectPath],
  );
  const [text, setTextState] = React.useState(() => readChatDraft(identity).text);
  const latestRef = React.useRef({ identity, text });
  const savedRef = React.useRef({ identity, text });
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const latest = latestRef.current;
    if (latest.identity === savedRef.current.identity && latest.text === savedRef.current.text) return;
    writeChatDraft(latest.identity, latest.text, []);
    savedRef.current = latest;
  }, []);

  const mountedRef = React.useRef(false);

  const setText = React.useCallback((value: string, saveNow = false) => {
    if (!mountedRef.current) return;
    latestRef.current = { identity: latestRef.current.identity, text: value };
    setTextState(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (saveNow) save();
    else timerRef.current = setTimeout(save, DRAFT_SAVE_DEBOUNCE_MS);
  }, [save]);

  const takeForAdd = React.useCallback((value: string) => {
    const owner = latestRef.current.identity;
    setText('', true);
    return () => {
      if (mountedRef.current && latestRef.current.identity === owner) {
        if (!latestRef.current.text.trim()) setText(value, true);
        return;
      }
      if (!readChatDraft(owner).text.trim()) writeChatDraft(owner, value, []);
    };
  }, [setText]);

  React.useLayoutEffect(() => {
    if (latestRef.current.identity === identity) return;
    save();
    const incoming = { identity, text: readChatDraft(identity).text };
    latestRef.current = incoming;
    savedRef.current = incoming;
    setTextState(incoming.text);
  }, [identity, save]);

  React.useEffect(() => {
    mountedRef.current = true;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') save();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('freeze', save);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('freeze', save);
      window.removeEventListener('pagehide', save);
      save();
      mountedRef.current = false;
    };
  }, [save]);

  React.useEffect(() => {
    const key = knowledgeFieldKey(identity);
    const change = (next: (text: string) => string) => setText(next(latestRef.current.text), true);
    mountedDrafts.set(key, change);
    return () => {
      if (mountedDrafts.get(key) === change) mountedDrafts.delete(key);
    };
  }, [identity, setText]);

  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CHAT_DRAFTS_STORAGE_KEY) return;
      const { identity: shown, text: current } = latestRef.current;
      const { identity: savedIdentity, text: saved } = savedRef.current;
      const stored = readChatDraft(shown).text;
      if (shown !== savedIdentity || stored === saved) return;
      const unsaved = current !== saved;
      const kept = saved.trimEnd();
      if (unsaved && !stored.startsWith(kept)) return;
      const merged = unsaved ? [current.trimEnd(), stored.slice(kept.length).trimStart()].filter(Boolean).join(' ') : stored;
      latestRef.current = { identity: shown, text: merged };
      savedRef.current = { identity: shown, text: stored };
      setTextState(merged);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { identity, text, setText, takeForAdd };
};
