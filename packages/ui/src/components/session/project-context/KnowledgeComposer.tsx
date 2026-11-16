import React from 'react';

import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { useEmojiPicker } from '@/components/emoji/useEmojiPicker';
import { createChatDraftIdentity, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { isIMECompositionEvent } from '@/lib/ime';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from './knowledgeRowStyle';
import { useI18n } from '@/lib/i18n';

/** The counter appears only once the text gets close to the limit. */
const COUNTER_THRESHOLD = 0.8;

/** The chat composer's debounce, for the same store. */
const DRAFT_SAVE_DEBOUNCE_MS = 500;

type KnowledgeDraftKind = 'note' | 'todo' | 'plan';

/**
 * The field's text, kept with the chat composer's drafts: one per project and
 * section, under a composer key no session id can take. Unsaved text survives
 * the field unmounting (another tab, another rail surface)
 * and a reload. Typing saves after a pause; leaving the field, hiding the page
 * and unloading it save at once, as the chat composer does.
 */
const useKnowledgeDraft = (projectPath: string, kind: KnowledgeDraftKind) => {
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

  // A field that has unmounted writes nothing: a newer field may own the draft.
  const mountedRef = React.useRef(false);

  const setText = React.useCallback((value: string, saveNow = false) => {
    if (!mountedRef.current) return;
    latestRef.current = { identity: latestRef.current.identity, text: value };
    setTextState(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (saveNow) save();
    else timerRef.current = setTimeout(save, DRAFT_SAVE_DEBOUNCE_MS);
  }, [save]);

  /** The text as typed so far, for appending without waiting for a render. */
  const currentText = React.useCallback(() => latestRef.current.text, []);

  /**
   * Starts an add: clears the field and its draft, and returns how to put the
   * text back if the add fails. It goes back only into an empty draft of the
   * same project and section, the field's if it is still that one's on screen.
   */
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

  // Another project in the same field: keep the outgoing draft, show its own.
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

  return { text, setText, currentText, takeForAdd };
};

/**
 * The one way every section adds an entry: a single line that grows with its
 * text. Enter adds. A multiline field follows the chat composer: Shift+Enter
 * starts a new line on desktop, and on a phone, whose keyboard has no
 * Shift+Enter, Return starts a new line and the Add button adds. A one-line
 * field turns pasted line breaks into spaces.
 *
 * The draft lives here, so dictation can continue it and a failed add can
 * put it back, and it is stored per project and section (`useKnowledgeDraft`).
 */
export const KnowledgeComposer: React.FC<{
  placeholder: string;
  addLabel: string;
  maxLength: number;
  /** Whose draft the field keeps: the project and the section. */
  projectPath: string;
  draftKind: KnowledgeDraftKind;
  multiline?: boolean;
  dictation?: boolean;
  disabled?: boolean;
  /** Resolves false when the entry was not added; the text then stays. */
  onSubmit: (text: string) => Promise<boolean> | boolean;
  /** Extra controls before the Add button, such as an import action. */
  extraActions?: React.ReactNode;
}> = ({ placeholder, addLabel, maxLength, projectPath, draftKind, multiline = false, dictation = true, disabled = false, onSubmit, extraActions }) => {
  const { t } = useI18n();
  const { text, setText, currentText, takeForAdd } = useKnowledgeDraft(projectPath, draftKind);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useEmojiPicker(fieldRef);
  const isMobile = useUIStore((state) => state.isMobile);
  const [submitting, setSubmitting] = React.useState(false);

  const normalize = React.useCallback((value: string) => (
    (multiline ? value : value.replace(/\r?\n/g, ' ')).slice(0, maxLength)
  ), [maxLength, multiline]);

  const submit = React.useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    // Cleared at once so the next entry can be typed while this one saves; a
    // failed add puts the text back unless something new was typed meanwhile.
    const putBack = takeForAdd(trimmed);
    setSubmitting(true);
    try {
      if (!await onSubmit(trimmed)) putBack();
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, submitting, takeForAdd, text]);

  const showCounter = text.length >= maxLength * COUNTER_THRESHOLD;
  // The field itself stays enabled while an entry saves: disabling it would
  // drop the focus, and the next entry typed right away would go nowhere.
  const blocked = disabled || submitting;
  const canSend = !blocked && text.trim().length > 0;

  return (
    <div
      className={cn(
        'flex items-end gap-1 py-1 pe-1',
        // On a phone it reads as the surface's other fields: flat, over a hairline.
        isMobile ? 'border-b border-edge-muted ps-1' : 'oc-surface-elevated oc-raised oc-field rounded-lg bg-[var(--surface-elevated)] ps-3',
        disabled && 'opacity-50',
      )}
    >
      <textarea
        ref={fieldRef}
        rows={1}
        value={text}
        onChange={(event) => setText(normalize(event.target.value))}
        onKeyDown={(event) => {
          if (isIMECompositionEvent(event)) return;
          if (event.key !== 'Enter') return;
          const modified = event.ctrlKey || event.metaKey;
          const submits = !multiline || modified || (!isMobile && !event.shiftKey);
          if (submits) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={multiline}
        autoComplete="off"
        className={cn(
          isMobile ? 'typography-meta' : 'typography-markdown md:typography-ui-label',
          'block min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 text-foreground outline-none placeholder:text-muted-foreground',
          multiline ? 'max-h-[calc(12lh+0.25rem)]' : 'max-h-[calc(6lh+0.25rem)]',
          'focus-visible:outline-none disabled:cursor-not-allowed',
        )}
      />
      {emojiPicker}
      {showCounter ? (
        <span className="flex h-6 flex-shrink-0 items-center typography-micro text-muted-foreground" dir="auto">
          {text.length}/{maxLength}
        </span>
      ) : null}
      {dictation ? (
        // Dictation continues the draft instead of adding it, so a misheard
        // word can be fixed before it lands.
        <InlineDictationButton
          onTranscript={(spoken) => {
            const current = currentText();
            setText(normalize(current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
          }}
          disabled={disabled}
          buttonClassName={KNOWLEDGE_ICON_BUTTON_CLASS}
        />
      ) : null}
      {extraActions}
      {/* A word, because an icon here meant something else every time: a plus
          read as "attach a file", the chat's send glyph as "send to the agent",
          the same glyph a todo row uses for exactly that. */}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSend}
        className={cn(
          'inline-flex h-6 flex-shrink-0 items-center rounded-md px-1.5 typography-ui-label font-medium transition-colors',
          'focus-visible:outline-none disabled:cursor-not-allowed',
          canSend ? 'text-[var(--primary-text)] hover:bg-interactive-hover' : 'text-muted-foreground opacity-50',
        )}
        aria-label={addLabel}
      >
        {t('rightSidebar.contextNotesTodo.composer.add')}
      </button>
    </div>
  );
};
