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
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerFileIntake } from './useComposerFileIntake';
import type { useComposerMobileShell } from './useComposerMobileShell';
import { getFileMentionInputSourceForInsertedText } from './composerMentionTokens';

type Dependencies = Pick<ReturnType<typeof useComposerSessionScope>, 'inputMode' | 'isBtwActive' | 'currentSessionId' | 'newSessionDraftOpen' | 'addAttachedFile'>
    & Pick<ReturnType<typeof useComposerLanguage>, 'sessionLinkOrigins' | 'resolveSessionLinks' | 'readPastedReferenceLinks' | 'pastedSessionIds'>
    & Pick<ReturnType<typeof useComposerInputState>, 'composerRef' | 'composerText' | 'setMessage' | 'largeTextPasteGesture' | 'pendingPastedAttachmentFilenamesRef' | 't' | 'largeTextPasteOfferIdRef' | 'setLargeTextPasteOffer'>
    & Pick<ReturnType<typeof useComposerReferenceDrafts>, 'receivedPageBases'>
    & Pick<ReturnType<typeof useComposerEditorActions>, 'updateAutocompleteState' | 'markFileMentionPasteSuppression' | 'insertTextAtSelection'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'largeTextPasteBehavior' | 'readLargeTextPasteSnapshot'>
    & Pick<ReturnType<typeof useComposerFileIntake>, 'attachFilesWithCitation'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;

export function useComposerPaste({
    inputMode, sessionLinkOrigins, resolveSessionLinks, isBtwActive, readPastedReferenceLinks,
    currentSessionId, newSessionDraftOpen, composerRef, composerText, receivedPageBases, setMessage,
    updateAutocompleteState, largeTextPasteGesture, largeTextPasteBehavior, readLargeTextPasteSnapshot,
    attachFilesWithCitation, markFileMentionPasteSuppression, pastedSessionIds, insertTextAtSelection,
    pendingPastedAttachmentFilenamesRef, addAttachedFile, t, largeTextPasteOfferIdRef,
    setLargeTextPasteOffer, mobileShell,
}: Dependencies) {
    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        // Narrowed alias so the rest of the handler reads as it did when this
        // was a React synthetic event, whose clipboardData is never null.
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        // A pasted link to another session or one of its messages pastes as
        // usual and draws as a chip once resolved.
        if (!isVSCodeRuntime() && inputMode === 'normal') {
            const links = findSessionLinks(e.clipboardData.getData('text'), sessionLinkOrigins);
            if (links.length > 0) void resolveSessionLinks(links.map((range) => range.target), true);
        }
        // Issue and PR links are read only when the text lands in the composer,
        // not when a large paste goes as a file.
        const readLinksOfPaste = (text: string) => {
            if (!isVSCodeRuntime() && inputMode === 'normal' && !isBtwActive) void readPastedReferenceLinks(text);
        };

        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const message = composerText.get();
                const selected = message.slice(selStart, selEnd);
                // A share link replaces the selection and becomes its chip; wrapped, its key would stay in the text.
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

        // Images get a citation and a generated name; every other clipboard
        // file (Finder/Explorer copy, a saved document) attaches as picked.
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
            // A copied file also carries its name as text; keep it out of the draft.
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

            // Must run synchronously — ComposerEditor does not consume paste.
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
                // Read live attachment + composer state at action time — the ask
                // toast can outlive the paste while the user types or attaches more.
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
                // Pending before the citation lands, so it shows as a chip at once.
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

            // A newer large paste replaces an unanswered choice.
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
                // Keep this in the tap's gesture: iOS won't raise the
                // keyboard when focus is restored after the attachment awaits.
                if (resolution.restoreFocus) {
                    if (composerRef.current) {
                        composerRef.current.focus({ preventScroll: isCapacitorApp() });
                    } else {
                        // The editor may have collapsed since the paste. The
                        // insertion above appends to its draft; expand mounts
                        // and focuses the editor with the platform's keyboard timing.
                        mobileShell.expand();
                    }
                }
            };

            setLargeTextPasteOffer({ id: offerId, resolve: resolveLargePaste });
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

    // Android commits an image through the IME instead of the page (see nativeImagePaste).
    React.useEffect(() => {
        setNativeImagePasteEnabled(mobileShell.focused);
    }, [mobileShell.focused]);

    // A composer unmounted while focused must not leave image commits enabled
    // for whatever field gets the keyboard next.
    React.useEffect(() => () => setNativeImagePasteEnabled(false), []);

    React.useEffect(() => subscribeToNativeImagePastes((paste) => {
        // Backstop for the window around the shell re-reading the declaration.
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
