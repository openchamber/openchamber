import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readChatDraftClaimingFolderDraft, type ChatDraftIdentity, type ChatDraftSnapshot } from '@/lib/chatDraftPersistence';
import type { FileMentionHandle } from '../../FileMentionAutocomplete';
import type { CommandAutocompleteHandle } from '../../CommandAutocomplete';
import type { SkillAutocompleteHandle } from '../../SkillAutocomplete';
import type { SnippetAutocompleteHandle } from '../../SnippetAutocomplete';
import type { EmojiAutocompleteHandle } from '@/components/emoji/EmojiAutocomplete';
import { useChatColumnActions, useChatColumnSession } from '../../chatColumnSession';
import { type MobileControlsPanel } from '../../mobileControlsUtils';
import { useI18n } from '@/lib/i18n';
import { LargeTextPasteGesture } from '../../composer/largeTextPaste';
import { type AutocompleteKind } from '../../composer/language/triggers';
import { type ComposerEditorHandle } from '../../composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from '../../composer/editor/viewStore';
import { createComposerText, useComposerTextValue } from '../../composer/state/composerText';
import { MentionCompletionState } from '../../composer/state/mentionCompletion';
import { type LargeTextPasteChoiceAction } from '../../composer/ui/LargeTextPasteChoice';
import { resolveChatDraftIdentity } from './composerDraftIdentity';

export function useComposerInputState() {
    const { t } = useI18n();

    // The session this composer belongs to: its column's (see
    // chatColumnSession.ts); outside a column it follows the live selection.
    const chatColumnSession = useChatColumnSession();

    const { pinned: columnPinned, openTimelineDialog, focusInput: focusColumnInput } = useChatColumnActions();

    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);

    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);

    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });

    // The draft text lives outside React state, so a keystroke re-renders only
    // what shows a value derived from it (see composerText.ts).
    const [composerText] = React.useState(() => {
        const identity = resolveChatDraftIdentity(chatColumnSession);
        const snapshot = readChatDraftClaimingFolderDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return createComposerText(snapshot.text);
    });

    // Bumped by every text the app puts into the composer, so the editor
    // writes it even when it equals the `value` it last rendered with.
    const [editorValueRevision, setEditorValueRevision] = React.useState(0);

    // Text the app puts into the composer: a restored draft, a picked command,
    // a cleared send. Typed text reaches `composerText` from the editor.
    const setMessage = React.useCallback((value: string) => {
        if (value === composerText.get()) return;
        composerText.set(value);
        setEditorValueRevision((revision) => revision + 1);
    }, [composerText]);

    const hasText = useComposerTextValue(composerText, (text) => text.trim().length > 0);

    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);

    const [storedInputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');

    const inputModeParentRef = React.useRef<string | null>(null);

    const [isDragging, setIsDragging] = React.useState(false);

    const [isInternalDrag, setIsInternalDrag] = React.useState(false);

    // At most one picker is open at a time; the prompt language decides which.
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);

    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');

    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);

    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);

    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);

    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);

    // Message history navigation state (up/down arrow to recall previous messages)
    const composerRef = React.useRef<ComposerEditorHandle>(null);

    const [mentionCompletion] = React.useState(() => new MentionCompletionState());

    const completingMentionRef = React.useRef(false);

    // The mobile composer swaps between the collapsed pill and the full
    // composer, which unmounts the editor. Building a CodeMirror view is far
    // from free, and it would happen inside the tap that expands the pill —
    // before the browser may paint the swap. The store keeps one view alive for
    // as long as the composer itself is mounted.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;

    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);

    const composerFormRef = React.useRef<HTMLFormElement | null>(null);

    const [promptHistorySearch, setPromptHistorySearch] = React.useState<{
        identity: string;
        initialQuery: string;
        olderRequest: number;
    } | null>(null);

    const [promptHistorySearchOwner, setPromptHistorySearchOwner] = React.useState<HTMLFormElement | null>(null);

    const [historyFocusPending, setHistoryFocusPending] = React.useState(false);

    const setPromptHistorySearchForm = React.useCallback((node: HTMLFormElement | null) => {
        composerFormRef.current = node;
        setPromptHistorySearchOwner(node);
    }, []);

    const cursorPosRef = React.useRef(0);

    const dropZoneRef = React.useRef<HTMLDivElement>(null);

    const dragEnterCountRef = React.useRef(0);

    const suppressNextFileDropTextInsertRef = React.useRef(false);

    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const suppressNextFileMentionPasteRef = React.useRef(false);

    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const shellTriggerNormalizationRef = React.useRef(false);

    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);

    const canAcceptDropRef = React.useRef(false);

    const mentionRef = React.useRef<FileMentionHandle>(null);

    const commandRef = React.useRef<CommandAutocompleteHandle>(null);

    const skillRef = React.useRef<SkillAutocompleteHandle>(null);

    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);

    const emojiRef = React.useRef<EmojiAutocompleteHandle>(null);

    const dictationSendInFlightRef = React.useRef(false);

    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);

    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());

    const pendingAttachWorkRef = React.useRef<Set<Promise<void>>>(new Set());

    /** Settles once the files being attached now are in; then the next render's handlers see them. */
    const waitForPendingAttachments = React.useCallback(async (): Promise<boolean> => {
        if (pendingAttachWorkRef.current.size === 0) return false;
        await Promise.allSettled([...pendingAttachWorkRef.current]);
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        return true;
    }, []);

    // The unanswered large-paste choice; `resolve` applies the answer once.
    const [largeTextPasteOffer, setLargeTextPasteOffer] = React.useState<{
        id: number;
        resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void;
    } | null>(null);

    const largeTextPasteOfferIdRef = React.useRef(0);

    const [largeTextPasteGesture] = React.useState(() => new LargeTextPasteGesture());

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // oxlint-disable-next-line typescript/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;

    // The record-and-send overlay holds the composer open until its submit
    // settles; the hold is released here (both handlers cover every exit).
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);

    return {
        chatColumnSession, inputModeParentRef, setInputMode, storedInputMode, columnPinned, composerText,
        composerFormRef, largeTextPasteGesture, largeTextPasteOfferIdRef, setLargeTextPasteOffer,
        composerRef, t, confirmedMentionsRef, pendingPastedAttachmentFilenamesRef, mobileControlsPanel,
        mobileAttachMenuOpen, mobileDraftPicker, promptHistorySearch, historyFocusPending, isDragging,
        currentChatDraftIdentityRef, setPromptHistorySearch, setHistoryFocusPending, setMessage,
        initialDraftRef, initialDraftIdentityRef, mentionCompletion, closeAutocomplete, focusColumnInput,
        setMobileControlsPanel, hasText, waitForPendingAttachments, openTimelineDialog, sendMessage,
        dictationSendEndRef, dictationSendInFlightRef, openAutocomplete, commandRef, skillRef, snippetRef,
        mentionRef, emojiRef, autocompleteQuery, dropZoneRef, setOpenAutocomplete, setAutocompleteQuery,
        suppressNextFileDropTextInsertRef, pendingDroppedAbsolutePathsRef,
        suppressNextFileDropTextInsertTimeoutRef, suppressNextFileMentionPasteRef,
        suppressNextFileMentionPasteTimeoutRef, completingMentionRef, shellTriggerNormalizationRef,
        setEditorValueRevision, pendingAttachWorkRef, canAcceptDropRef, dragEnterCountRef, isInternalDrag,
        setIsInternalDrag, setIsDragging, cursorPosRef, setMobileDraftPicker, largeTextPasteOffer,
        promptHistorySearchOwner, setMobileAttachMenuOpen, setPromptHistorySearchForm, composerViewStore,
        editorValueRevision,
    };
}
