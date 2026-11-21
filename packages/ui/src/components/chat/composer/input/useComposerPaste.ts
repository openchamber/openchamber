import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerLargePasteScope } from './useComposerLargePasteScope';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerFileIntake } from './useComposerFileIntake';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import React from 'react';
import { useInputStore } from '@/sync/input-store';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { setNativeImagePasteEnabled, subscribeToNativeImagePastes } from '@/lib/nativeImagePaste';
import { bareSessionId, findSessionLinks } from '@/lib/sessionLinks';
import { buildAttachmentCitationText, nextPastedContextFilename } from '../../attachmentCitations';
import { createPastedContextFile, isLargePlainTextPaste, type LargeTextPasteCandidate } from '../../composer/largeTextPaste';
import { beginLargeTextPasteOffer, resolveLargeTextPasteOffer } from '../../composer/largeTextPasteOffer';
import type { LargeTextPasteBehavior } from '@/stores/useUIStore';
import { shouldWrapSelectionAsLink, withInlineInsertionBoundaries } from '../../composer/text';
import { type LargeTextPasteChoiceAction } from '../../composer/ui/LargeTextPasteChoice';
import { findShareLink } from '@/lib/received-pages/link';
import { getFileMentionInputSourceForInsertedText } from './composerMentionTokens';

type Dependencies = {
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'inputMode' | 'isBtwActive' | 'currentSessionId' | 'newSessionDraftOpen' | 'addAttachedFile'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'sessionLinkOrigins' | 'resolveSessionLinks' | 'readPastedReferenceLinks' | 'pastedSessionIds'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText' | 'setMessage'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteGesture' | 'largeTextPasteOfferIdRef' | 'setLargeTextPasteOffer'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'pendingPastedAttachmentFilenamesRef'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'receivedPageBases'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'updateAutocompleteState' | 'markFileMentionPasteSuppression' | 'insertTextAtSelection'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'largeTextPasteBehavior'>;
    largePasteScope: Pick<ReturnType<typeof useComposerLargePasteScope>, 'readLargeTextPasteSnapshot'>;
    fileIntake: Pick<ReturnType<typeof useComposerFileIntake>, 'attachFilesWithCitation'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;
};

export function useComposerPaste({
    sessionScope, language, editorState, draftText, largePasteState, attachmentWork, i18n,
    referenceDrafts, editorActions, preferences, largePasteScope, fileIntake, mobileShell: mobile,
}: Dependencies) {
    const { inputMode, isBtwActive, currentSessionId, newSessionDraftOpen, addAttachedFile } = sessionScope;
    const { sessionLinkOrigins, resolveSessionLinks, readPastedReferenceLinks, pastedSessionIds } = language;
    const { composerRef } = editorState;
    const { composerText, setMessage } = draftText;
    const { largeTextPasteGesture, largeTextPasteOfferIdRef, setLargeTextPasteOffer } = largePasteState;
    const { pendingPastedAttachmentFilenamesRef } = attachmentWork;
    const { t } = i18n;
    const { receivedPageBases } = referenceDrafts;
    const { updateAutocompleteState, markFileMentionPasteSuppression, insertTextAtSelection } = editorActions;
    const { largeTextPasteBehavior } = preferences;
    const { readLargeTextPasteSnapshot } = largePasteScope;
    const { attachFilesWithCitation } = fileIntake;
    const { mobileShell } = mobile;

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        if (!isVSCodeRuntime() && inputMode === 'normal') {
            const links = findSessionLinks(e.clipboardData.getData('text'), sessionLinkOrigins);
            if (links.length > 0) void resolveSessionLinks(links.map((range) => range.target), true);
        }
        const readLinksOfPaste = (text: string) => {
            if (!isVSCodeRuntime() && inputMode === 'normal' && !isBtwActive) void readPastedReferenceLinks(text);
        };

        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const message = composerText.get();
                const selected = message.slice(selStart, selEnd);
                if (shouldWrapSelectionAsLink(url, selected) && !findShareLink(url, receivedPageBases)) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    setMessage(next);
                    composerRef.current?.setSelection(caret, caret);
                    updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
                    largeTextPasteGesture.invalidate();
                    return;
                }
            }
        }

        const imageMap = new Map<string, File>();
        const otherFileMap = new Map<string, File>();
        const collectClipboardFile = (file: File) => {
            const target = file.type.startsWith('image/') ? imageMap : otherFileMap;
            target.set(`${file.name}-${file.size}`, file);
        };

        Array.from(e.clipboardData.files || []).forEach(collectClipboardFile);

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind !== 'file') return;
            const file = item.getAsFile();
            if (file) collectClipboardFile(file);
        });

        const imageFiles = Array.from(imageMap.values());
        const otherFiles = Array.from(otherFileMap.values());
        const pastedText = e.clipboardData.getData('text');
        const sessionReady = Boolean(currentSessionId || newSessionDraftOpen);

        let conversion: LargeTextPasteCandidate | null = null;
        if (largeTextPasteBehavior === 'inline-double-paste') {
            const snapshot = readLargeTextPasteSnapshot();
            if (snapshot && sessionReady && inputMode === 'normal' && imageFiles.length === 0 && otherFiles.length === 0) {
                conversion = largeTextPasteGesture.beginPaste(pastedText, snapshot);
            } else {
                largeTextPasteGesture.invalidate();
            }
        }

        if (imageFiles.length === 0 && otherFiles.length > 0) {
            e.preventDefault();
            if (!sessionReady) return;
            await attachFilesWithCitation(otherFiles);
            return;
        }

        if (imageFiles.length === 0) {
            const behavior: LargeTextPasteBehavior = largeTextPasteBehavior;
            const shouldOfferLargePaste = sessionReady
                && inputMode === 'normal'
                && behavior !== 'inline'
                && (behavior !== 'inline-double-paste' || conversion !== null)
                && isLargePlainTextPaste(pastedText);

            if (!shouldOfferLargePaste) {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                const sessionId = !isVSCodeRuntime() && inputMode === 'normal' ? bareSessionId(pastedText) : null;
                if (sessionId) pastedSessionIds.expect(sessionId);
                readLinksOfPaste(pastedText);
                return;
            }

            e.preventDefault();

            const pasteInline = () => {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                insertTextAtSelection(
                    pastedText,
                    getFileMentionInputSourceForInsertedText(pastedText),
                );
                readLinksOfPaste(pastedText);
            };

            const attachAsFile = async (candidate: LargeTextPasteCandidate | null = null) => {
                const liveAttachedFiles = useInputStore.getState().attachedFiles;
                const filename = nextPastedContextFilename([
                    ...liveAttachedFiles.map((file) => file.filename),
                    ...pendingPastedAttachmentFilenamesRef.current,
                ]);
                const citationText = buildAttachmentCitationText([filename]);
                const editor = composerRef.current;
                const currentMessage = editor?.getValue() ?? composerText.get();
                const selectionStart = editor?.getSelection().start ?? currentMessage.length;
                const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
                const insertionText = withInlineInsertionBoundaries(
                    citationText,
                    currentMessage.slice(0, candidate?.from ?? selectionStart),
                    currentMessage.slice(candidate?.to ?? selectionEnd),
                );

                const file = createPastedContextFile(pastedText, filename);
                pendingPastedAttachmentFilenamesRef.current.add(filename);
                try {
                    if (!candidate) {
                        insertTextAtSelection(
                            insertionText,
                            getFileMentionInputSourceForInsertedText(insertionText),
                        );
                    }

                    if (candidate) {
                        await largeTextPasteGesture.convert(
                            candidate, async () => {
                                const accepted = await addAttachedFile(file);
                                if (!accepted && readLargeTextPasteSnapshot()?.scope === candidate.scope) {
                                    toast.error(t('chat.chatInput.toast.clipboardTextAttachFailed'));
                                }
                                return accepted;
                            }, readLargeTextPasteSnapshot,
                            (from, to, citation) => composerRef.current?.replaceRange(from, to, citation),
                            insertionText,
                        );
                    } else {
                        await addAttachedFile(file);
                    }
                } catch (error) {
                    console.error('Clipboard text attach failed', error);
                    toast.error(
                        error instanceof Error
                            ? error.message
                            : t('chat.chatInput.toast.clipboardTextAttachFailed'),
                    );
                } finally {
                    pendingPastedAttachmentFilenamesRef.current.delete(filename);
                }
            };

            if (conversion) {
                await attachAsFile(conversion);
                return;
            }

            if (behavior === 'attach') {
                await attachAsFile();
                return;
            }

            const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
            largeTextPasteOfferIdRef.current = offerId;

            const resolveLargePaste = (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => {
                const resolution = resolveLargeTextPasteOffer(
                    largeTextPasteOfferIdRef.current,
                    offerId,
                    { explicitlyChosen },
                );
                largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                if (!resolution.accepted) {
                    return;
                }
                setLargeTextPasteOffer(null);
                if (action === 'attach') {
                    void attachAsFile();
                } else {
                    pasteInline();
                }
                if (typedText) {
                    insertTextAtSelection(typedText);
                }
                if (resolution.restoreFocus) {
                    const editor = composerRef.current;
                    if (editor) {
                        const { start, end } = editor.getSelection();
                        editor.focus({ preventScroll: isCapacitorApp() });
                        editor.setSelection(start, end);
                    } else {
                        mobileShell.expand();
                    }
                }
            };

            setLargeTextPasteOffer({ id: offerId, kind: 'text', resolve: resolveLargePaste });
            return;
        }

        if (!sessionReady) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        e.preventDefault();
        await attachFilesWithCitation([...imageFiles, ...otherFiles], pastedText);
    }, [addAttachedFile, attachFilesWithCitation, currentSessionId, inputMode, largeTextPasteBehavior, largeTextPasteGesture, readLargeTextPasteSnapshot, markFileMentionPasteSuppression, composerText, mobileShell, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState, resolveSessionLinks, sessionLinkOrigins, pastedSessionIds, isBtwActive, readPastedReferenceLinks, receivedPageBases, pendingPastedAttachmentFilenamesRef, largeTextPasteOfferIdRef, setLargeTextPasteOffer, composerRef]);

    React.useEffect(() => {
        setNativeImagePasteEnabled(mobileShell.focused);
    }, [mobileShell.focused]);

    React.useEffect(() => () => setNativeImagePasteEnabled(false), []);

    React.useEffect(() => subscribeToNativeImagePastes((paste) => {
        if (!mobileShell.focused) return;
        if (!paste.ok) {
            toast.error(t('chat.chatInput.toast.clipboardAttachFailed'));
            return;
        }
        if (!currentSessionId && !newSessionDraftOpen) return;
        void attachFilesWithCitation([paste.file]);
    }), [attachFilesWithCitation, currentSessionId, mobileShell.focused, newSessionDraftOpen, t]);

    return {
        handlePaste,
    };
}
