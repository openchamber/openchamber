import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerLargePasteScope } from './useComposerLargePasteScope';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDropState } from './useComposerDropState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerAutocompleteState } from './useComposerAutocompleteState';
import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { cycleThinkingVariant } from '@/lib/cycleThinkingVariant';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getCycledPrimaryAgentName } from '../../mobileControlsUtils';
import { isAutoModel } from '@/lib/routing/autoModel';
import { composerReferenceKey, withComposerReferences } from '../../composer/composerReferences';
import type { FileMentionAutocompleteInputSource } from '../../fileMentionAutocompleteState';
import { resolveAutocompleteTrigger } from '../../composer/language/triggers';
import { type ComposerChange } from '../../composer/editor/ComposerEditor';
import { useComposerHeightLimit } from '../../composer/editor/useComposerHeightLimit';
import { useAutocompletePosition } from '../../composer/state/useAutocompletePosition';
import { findShareLink, withoutShareLinkKeys } from '@/lib/received-pages/link';
import { takeShareLink } from '../../sharePages/received/takeShareLink';
import { usePlaceholderFitsOneLine } from '../../composer/ui/usePlaceholderFitsOneLine';
import { MAX_MOBILE_COMPOSER_LINES, MAX_VISIBLE_COMPOSER_LINES, MOBILE_COMPOSER_BOUND_GAP_PX } from './composerInputLimits';
import { continuesSessionMention } from './composerMentionTokens';

type Dependencies = {
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile' | 'largeTextPasteBehavior'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'isComposerExpanded'>;
    largePasteScope: Pick<ReturnType<typeof useComposerLargePasteScope>, 'getLargeTextPasteScope'>;
    autocompleteState: Pick<ReturnType<typeof useComposerAutocompleteState>, 'openAutocomplete' | 'autocompleteQuery' | 'mentionCompletion' | 'setOpenAutocomplete' | 'setAutocompleteQuery' | 'completingMentionRef' | 'closeAutocomplete'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText' | 'setMessage' | 'setEditorValueRevision' | 'setInputMode'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef' | 'shellTriggerNormalizationRef'>;
    dropState: Pick<ReturnType<typeof useComposerDropState>, 'dropZoneRef' | 'suppressNextFileDropTextInsertRef' | 'pendingDroppedAbsolutePathsRef' | 'suppressNextFileDropTextInsertTimeoutRef' | 'suppressNextFileMentionPasteRef' | 'suppressNextFileMentionPasteTimeoutRef'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteGesture'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'clearAbortPrompt' | 'isBtwActive' | 'btwSessionId' | 'currentSessionId' | 'abortCurrentOperation' | 'pickSessionAgent' | 'inputMode'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'handleOpenMobilePanel'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'agents' | 'currentAgentName' | 'setAgent'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'pastedSessionIds' | 'linkPastedSessionId' | 'setOpenSharedPageKey'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'receivedPageBases' | 'updateLinkedReferences'>;
};

export function useComposerEditorActions({
    preferences, expansion, largePasteScope, autocompleteState, draftText, editorState, dropState,
    column, i18n, largePasteState, sessionScope, sessionLifecycle, selection, language, referenceDrafts,
}: Dependencies) {
    const { isMobile, largeTextPasteBehavior } = preferences;
    const { isComposerExpanded } = expansion;
    const { getLargeTextPasteScope } = largePasteScope;
    const {
        openAutocomplete, autocompleteQuery, mentionCompletion, setOpenAutocomplete,
        setAutocompleteQuery, completingMentionRef, closeAutocomplete,
    } = autocompleteState;
    const { composerText, setMessage, setEditorValueRevision, setInputMode } = draftText;
    const { composerRef, shellTriggerNormalizationRef } = editorState;
    const {
        dropZoneRef, suppressNextFileDropTextInsertRef, pendingDroppedAbsolutePathsRef,
        suppressNextFileDropTextInsertTimeoutRef, suppressNextFileMentionPasteRef,
        suppressNextFileMentionPasteTimeoutRef,
    } = dropState;
    const { columnPinned } = column;
    const { t } = i18n;
    const { largeTextPasteGesture } = largePasteState;
    const {
        clearAbortPrompt, isBtwActive, btwSessionId, currentSessionId, abortCurrentOperation,
        pickSessionAgent, inputMode,
    } = sessionScope;
    const { handleOpenMobilePanel } = sessionLifecycle;
    const { currentProviderId, currentModelId, agents, currentAgentName, setAgent } = selection;
    const { pastedSessionIds, linkPastedSessionId, setOpenSharedPageKey } = language;
    const { receivedPageBases, updateLinkedReferences } = referenceDrafts;

    // The open picker sits at the caret, right above the line being typed.
    const {
        position: autocompleteOverlayPosition,
        update: updateAutocompleteOverlayPosition,
    } = useAutocompletePosition({
        fullWidth: isMobile,
        openAutocomplete,
        query: autocompleteQuery,
        text: composerText,
        editorRef: composerRef,
        containerRef: dropZoneRef,
    });

    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();

        // btw mode: the stop button stops the fork's turn, not the main
        // session's.
        const abortTarget = isBtwActive && btwSessionId ? btwSessionId : currentSessionId;
        void abortCurrentOperation(abortTarget || undefined);
    }, [abortCurrentOperation, btwSessionId, clearAbortPrompt, currentSessionId, isBtwActive]);

    const handleCycleThinking = React.useCallback(() => {
        cycleThinkingVariant(currentSessionId);
    }, [currentSessionId]);

    const handleOpenThinkingPanel = React.useCallback(() => handleOpenMobilePanel('variant'), [handleOpenMobilePanel]);

    const handleCycleAgent = React.useCallback((direction: 1 | -1 = 1) => {
        // Auto hides the agent control, so the shortcut must not change a
        // choice the user cannot see.
        if (isAutoModel(currentProviderId, currentModelId)) return;
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction, useUIStore.getState().favoriteAgents);
        if (!nextAgentName) return;

        if (currentSessionId) {
            pickSessionAgent(currentSessionId, nextAgentName);
        }

        // A pinned column's agent is its own session's choice only.
        if (!columnPinned) setAgent(nextAgentName);
    }, [agents, columnPinned, currentAgentName, currentModelId, currentProviderId, currentSessionId, setAgent, pickSessionAgent]);

    // Height the failed-dictation salvage text needs. Its overlay sits
    // absolutely over the composer, so the composer must be able to grow for
    // it. Apply the editor's line and screen bounds before using that height as
    // a floor, otherwise long salvage text can push the action row off-screen.
    const dictationHeightHostRef = React.useRef<HTMLDivElement | null>(null);

    // The short hint drops the @, $ and / pointers, so it only replaces the
    // full one when that would wrap.
    const fullChatPlaceholderFits = usePlaceholderFitsOneLine(dictationHeightHostRef, t('chat.chatInput.placeholder.chat'));

    const useCompactChatPlaceholder = isMobile || !fullChatPlaceholderFits;

    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);

    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);

    const dictationHeightLimit = useComposerHeightLimit({
        active: dictationContentHeight !== null,
        disabled: isComposerExpanded,
        hostRef: dictationHeightHostRef,
        maxLines: isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES,
        boundSelector: isMobile ? '[data-composer-bound]' : undefined,
        boundGapPx: isMobile ? MOBILE_COMPOSER_BOUND_GAP_PX : 0,
    });

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
            inputMode,
            mentionsEnabled: !isBtwActive,
            inputSource,
            insertedText,
            mentionIsCompleted: (start) => mentionCompletion.isCompleted(start),
            // Session titles hold spaces, so `@release notes` keeps looking.
            // VS Code lists no sessions under `@`.
            mentionContinuesPastSpace: isVSCodeRuntime()
                ? undefined
                : (query) => continuesSessionMention(query, currentSessionId),
        });
        setOpenAutocomplete(trigger?.kind ?? null);
        setAutocompleteQuery(trigger?.query ?? '');
    }, [currentSessionId, inputMode, isBtwActive, mentionCompletion, setOpenAutocomplete, setAutocompleteQuery]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const editor = composerRef.current;
        if (!editor) {
            // No mounted editor (collapsed mobile pill): append to the state
            // the editor will be seeded from.
            const nextValue = composerText.get() + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length, inputSource, text);
            return;
        }

        const { start, end } = editor.getSelection();
        // Read the live document — delayed toast actions must not use a
        // paste-time React `message` closure.
        const currentMessage = editor.getValue();
        const nextValue = `${currentMessage.substring(0, start)}${text}${currentMessage.substring(end)}`;
        const cursorPosition = start + text.length;

        // One dispatch places both the text and the caret, so there is no
        // frame where the caret sits at a stale offset.
        editor.insertText(text);
        updateAutocompleteState(nextValue, cursorPosition, inputSource, text);
    }, [updateAutocompleteState, setMessage, composerText, composerRef]);

    const clearDropTextSuppression = React.useCallback(() => {
        suppressNextFileDropTextInsertRef.current = false;
        pendingDroppedAbsolutePathsRef.current = [];
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
            suppressNextFileDropTextInsertTimeoutRef.current = null;
        }
    }, [suppressNextFileDropTextInsertTimeoutRef, suppressNextFileDropTextInsertRef, pendingDroppedAbsolutePathsRef]);

    const scheduleDropTextSuppressionExpiry = React.useCallback(() => {
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
        }
        suppressNextFileDropTextInsertTimeoutRef.current = setTimeout(() => {
            clearDropTextSuppression();
        }, 700);
    }, [clearDropTextSuppression, suppressNextFileDropTextInsertTimeoutRef]);

    const clearFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = false;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }
    }, [suppressNextFileMentionPasteRef, suppressNextFileMentionPasteTimeoutRef]);

    const markFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = true;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
        }
        suppressNextFileMentionPasteTimeoutRef.current = setTimeout(() => {
            suppressNextFileMentionPasteRef.current = false;
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }, 700);
    }, [suppressNextFileMentionPasteRef, suppressNextFileMentionPasteTimeoutRef]);

    const handleComposerChange = ({ value, selection, changes, fromPaste, insertedText, fromValueProp }: ComposerChange) => {
        const pastedSessionId = pastedSessionIds.applyChange({ value, changes, fromPaste, fromValueProp });
        if (pastedSessionId) void linkPastedSessionId(pastedSessionId);
        if (fromValueProp) {
            mentionCompletion.clear();
        } else {
            mentionCompletion.applyChange(changes, completingMentionRef.current);
        }
        if (largeTextPasteBehavior === 'inline-double-paste') {
            largeTextPasteGesture.change({
                value, selection, fromPaste, insertedText,
                scope: getLargeTextPasteScope(),
            });
        }
        if (shellTriggerNormalizationRef.current) {
            shellTriggerNormalizationRef.current = false;
            composerText.set(value);
            return;
        }

        // VS Code drops the dragged path as text as well as firing the drop
        // handler; swallow that duplicate insertion.
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            if (candidateAbsolutePaths.some((path) => path.length > 0 && value.includes(path))) {
                clearDropTextSuppression();
                // The editor goes back to the text without the path.
                setEditorValueRevision((revision) => revision + 1);
                return;
            }
        }

        const pastedInsertedText = fromPaste ? insertedText : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput ? 'paste' : 'manual';

        // A leading `!` switches the composer into shell mode and is consumed.
        // Mobile keyboards and paste may update the document without a usable
        // keydown, so consume the trigger in the same editor transaction rather
        // than moving the caret in a later frame against stale text.
        if (!isBtwActive && inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, selection.start - 1);
            setInputMode('shell');
            closeAutocomplete();
            const editor = composerRef.current;
            if (editor) {
                shellTriggerNormalizationRef.current = true;
                editor.replaceRange(0, 1, '', nextCursor);
            } else {
                setMessage(shellCommand);
            }
            return;
        }

        // A share link someone sent becomes a page chip: the link, with its
        // key, goes to the server and only the link without its key stays in
        // the text, where it draws as the chip. Its card opens at once, since
        // the page needs its PIN.
        const shareLink = !fromValueProp && !isBtwActive && inputMode === 'normal' ? findShareLink(value, receivedPageBases) : null;
        if (shareLink && composerRef.current) {
            const link = withoutShareLinkKeys(shareLink.url);
            const reference = { ...takeShareLink(shareLink), link };
            updateLinkedReferences((current) => withComposerReferences(current, [reference]));
            setOpenSharedPageKey(composerReferenceKey(reference));
            composerRef.current.replaceRange(shareLink.start, shareLink.end, link, shareLink.start + link.length);
            return;
        }

        composerText.set(value);
        // Text the app set (a restored draft, a prepared prompt) is not a
        // trigger being typed: a `#` line in it must not open the snippet list.
        if (fromValueProp) {
            closeAutocomplete();
            return;
        }
        updateAutocompleteState(value, selection.start, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    return {
        handleCycleAgent, insertTextAtSelection, updateAutocompleteState, markFileMentionPasteSuppression,
        clearDropTextSuppression, scheduleDropTextSuppressionExpiry, handleCycleThinking,
        handleOpenThinkingPanel, handleComposerChange, updateAutocompleteOverlayPosition, handleAbort,
        autocompleteOverlayPosition, dictationHeightHostRef, dictationContentHeight, dictationHeightLimit,
        useCompactChatPlaceholder, handleDictationContentHeightChange,
    };
}
