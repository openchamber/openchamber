import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerMobileShell } from './useComposerMobileShell';
import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { MAX_ATTACHMENT_BYTES, MAX_INLINE_ATTACHMENT_BYTES, useInputStore, type AddAttachedFileOptions } from '@/sync/input-store';
import { getChatDraftIdentityKey, workDraftIdOfComposerKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { resolveOpenWorkDraftIdentity } from './composerDraftIdentity';
import { toast } from '@/components/ui';
import { assignImageAttachmentFilenames, buildAttachmentCitationText, findImagePathCitationNames, imageSaveModeForModel, renameFileForAttachmentCitation } from '../../attachmentCitations';
import { assignFileAttachmentFilenames, attachmentsCitedIn } from '@/lib/attachmentIdentity';
import { buildImagePasteInsertion, withInlineInsertionBoundaries } from '../../composer/text';
import { getFileMentionInputSourceForInsertedText } from './composerMentionTokens';
import { isDocumentAttachmentFilename } from '@/sync/attachment-files';
import { isCapacitorApp } from '@/lib/platform';
import { beginLargeTextPasteOffer, resolveLargeTextPasteOffer } from '../../composer/largeTextPasteOffer';
import type { LargeTextPasteChoiceAction } from '../../composer/ui/LargeTextPasteChoice';
import type { RejectedSharedFile } from '@/lib/nativeSharedFiles';

export type SharedAttachOptions = {
    leadingText: string;
    target: ChatDraftIdentity;
    writeAway: (target: ChatDraftIdentity, text: string) => void;
};

type Dependencies = {
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'pendingPastedAttachmentFilenamesRef' | 'pendingAttachWorkRef'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'insertTextAtSelection'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentModelMetadata'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'addAttachedFile' | 'chatDraftIdentity' | 'attachedFiles'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteOfferIdRef' | 'setLargeTextPasteOffer'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;
};

export function useComposerFileIntake({
    editorState, draftText, i18n, attachmentWork, editorActions, selection, sessionScope, largePasteState, mobileShell: mobileShellState,
}: Dependencies) {
    const { composerRef } = editorState;
    const { composerText } = draftText;
    const { t } = i18n;
    const { pendingPastedAttachmentFilenamesRef, pendingAttachWorkRef } = attachmentWork;
    const { insertTextAtSelection } = editorActions;
    const { currentModelMetadata } = selection;
    const { addAttachedFile, chatDraftIdentity, attachedFiles } = sessionScope;
    const { largeTextPasteOfferIdRef, setLargeTextPasteOffer } = largePasteState;
    const { mobileShell } = mobileShellState;

    const insertCitationAtSelection = React.useCallback((citationText: string, leadingText: string) => {
        if (!citationText && !leadingText) return;
        const editor = composerRef.current;
        const currentMessage = editor?.getValue() ?? composerText.get();
        const selectionStart = editor?.getSelection().start ?? currentMessage.length;
        const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
        const insertionText = withInlineInsertionBoundaries(
            buildImagePasteInsertion(leadingText, citationText),
            currentMessage.slice(0, selectionStart),
            currentMessage.slice(selectionEnd),
        );
        insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));
    }, [insertTextAtSelection, composerText, composerRef]);

    const savePastedImagesAsFiles = useUIStore((state) => state.savePastedImagesAsFiles);

    const imageSaveMode = imageSaveModeForModel(savePastedImagesAsFiles, currentModelMetadata?.modalities?.input);

    const renameCitation = React.useCallback((from: string, to: string) => {
        const editor = composerRef.current;
        if (!editor) return;
        const citation = `[${from}]`;
        const text = editor.getValue();
        const start = text.lastIndexOf(citation);
        if (start >= 0) editor.replaceRange(start, start + citation.length, `[${to}]`);
    }, [composerRef]);

    const attachFilesWithCitationNow = React.useCallback(async (
        files: File[],
        leadingText: string = '',
        documentsAsIs: boolean = false,
    ): Promise<void> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

        const insertCitation = (filenames: string[], text: string) => {
            insertCitationAtSelection(filenames.length > 0 ? buildAttachmentCitationText(filenames) : '', text);
        };

        const usedNames = () => [
            ...useInputStore.getState().attachedFiles.map((file) => file.filename),
            ...pendingPastedAttachmentFilenamesRef.current,
            ...findImagePathCitationNames(composerRef.current?.getValue() ?? composerText.get()),
        ];

        let attached = false;
        const imageOptions: AddAttachedFileOptions | undefined = imageSaveMode === 'attach'
            ? undefined
            : { saveOnSend: imageSaveMode === 'instead' ? 'reference' : 'copy' };
        const assignedImageNames = assignImageAttachmentFilenames(imageFiles, usedNames());
        for (const filename of assignedImageNames) pendingPastedAttachmentFilenamesRef.current.add(filename);
        insertCitation(assignedImageNames, leadingText);

        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedImageNames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            try {
                attached = (await addAttachedFile(file, undefined, ([landed]) => {
                    if (landed && landed.filename.toLowerCase() !== filename.toLowerCase()) renameCitation(filename, landed.filename);
                }, imageOptions)) || attached;
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) {
                for (const rest of assignedImageNames.slice(index + 1)) pendingPastedAttachmentFilenamesRef.current.delete(rest);
                return;
            }
        }

        const attachedOtherNames: string[] = [];
        let reported = false;
        const otherNames = assignFileAttachmentFilenames(otherFiles, usedNames());
        for (let index = 0; index < otherFiles.length; index += 1) {
            const file = otherNames[index] === otherFiles[index].name
                ? otherFiles[index]
                : renameFileForAttachmentCitation(otherFiles[index], otherNames[index]);
            const asIs = documentsAsIs && isDocumentAttachmentFilename(file.name);
            try {
                let landedName = file.name;
                let landedAsPath = false;
                if (await addAttachedFile(file, undefined, ([landed]) => {
                    if (!landed) return;
                    landedName = landed.filename;
                    landedAsPath = Boolean(landed.agentPath);
                }, asIs ? { saveOnSend: 'reference' } : undefined)) {
                    attached = true;
                    attachedOtherNames.push(landedName);
                    if (landedAsPath && !asIs && isDocumentAttachmentFilename(file.name)) toast.info(t('chat.fileAttachment.toast.documentAttachedAsPath', { name: file.name }));
                }
            } catch (error) {
                console.error('File attach failed', error);
                if (error instanceof Error) {
                    toast.error(error.message);
                    reported = true;
                }
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        insertCitation(attachedOtherNames, '');

        if (files.length > 0 && !attached && !reported) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, imageSaveMode, insertCitationAtSelection, renameCitation, t, composerText, composerRef, pendingPastedAttachmentFilenamesRef]);

    const seenVSCodeAttachmentsRef = React.useRef<{ draftKey: string; ids: Set<string> } | null>(null);

    React.useEffect(() => {
        const draftKey = chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : '';
        const vscodeFiles = attachedFiles.filter((file) => file.source === 'vscode');
        const seen = seenVSCodeAttachmentsRef.current;
        seenVSCodeAttachmentsRef.current = { draftKey, ids: new Set(vscodeFiles.map((file) => file.id)) };
        if (!seen || seen.draftKey !== draftKey) return;
        const fresh = vscodeFiles.filter((file) => !seen.ids.has(file.id));
        if (fresh.length === 0) return;
        const text = composerRef.current?.getValue() ?? composerText.get();
        const uncited = fresh.filter((file) => attachmentsCitedIn(text, [file]).length === 0);
        if (uncited.length > 0) insertCitationAtSelection(buildAttachmentCitationText(uncited.map((file) => file.filename)), '');
    }, [attachedFiles, chatDraftIdentity, composerText, insertCitationAtSelection, composerRef]);

    const trackAttachWork = React.useCallback((work: Promise<void>): Promise<void> => {
        pendingAttachWorkRef.current.add(work);
        const settle = () => { pendingAttachWorkRef.current.delete(work); };
        work.then(settle, settle);
        return work;
    }, [pendingAttachWorkRef]);

    const offerDocumentChoice = React.useCallback((documents: File[]) => {
        const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
        largeTextPasteOfferIdRef.current = offerId;
        const resolve = (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => {
            const resolution = resolveLargeTextPasteOffer(largeTextPasteOfferIdRef.current, offerId, { explicitlyChosen });
            largeTextPasteOfferIdRef.current = resolution.nextOfferId;
            if (!resolution.accepted) return;
            setLargeTextPasteOffer(null);
            void trackAttachWork(attachFilesWithCitationNow(documents, '', action === 'attach'));
            if (typedText) insertTextAtSelection(typedText);
            if (resolution.restoreFocus) {
                if (composerRef.current) composerRef.current.focus({ preventScroll: isCapacitorApp() });
                else mobileShell.expand();
            }
        };
        setLargeTextPasteOffer({ id: offerId, kind: 'documents', resolve });
        if (useUIStore.getState().isMobile && !mobileShell.expanded) mobileShell.expand();
    }, [attachFilesWithCitationNow, insertTextAtSelection, largeTextPasteOfferIdRef, mobileShell, setLargeTextPasteOffer, trackAttachWork, composerRef]);

    const attachSharedFiles = React.useCallback((
        files: File[],
        { leadingText, target, writeAway }: SharedAttachOptions,
    ): Promise<RejectedSharedFile[]> => {
        const workDraftId = workDraftIdOfComposerKey(target.sessionId);
        let latestTarget = target;
        const currentTarget = (): ChatDraftIdentity => {
            const open = workDraftId ? resolveOpenWorkDraftIdentity(workDraftId, target.runtimeKey) : null;
            if (open) latestTarget = open;
            return latestTarget;
        };
        const followDraft = (used: ChatDraftIdentity) => {
            const now = currentTarget();
            if (getChatDraftIdentityKey(now) !== getChatDraftIdentityKey(used)) useInputStore.getState().moveAttachedFiles(used, now);
        };
        const isOnScreen = () => useInputStore.getState().attachmentDraftKey === getChatDraftIdentityKey(currentTarget());
        const rejected: RejectedSharedFile[] = [];
        const reserved = pendingPastedAttachmentFilenamesRef.current;
        const place = (names: string[], text: string) => {
            const citation = names.length > 0 ? buildAttachmentCitationText(names) : '';
            if (!citation && !text) return;
            if (isOnScreen()) insertCitationAtSelection(citation, text);
            else writeAway(currentTarget(), buildImagePasteInsertion(text, citation));
        };
        const attachLocally = async (file: File, landedNames: string[]) => {
            const used = currentTarget();
            try {
                const attached = await addAttachedFile(file, used, (landed) => {
                    landedNames.push(...landed.map((entry) => entry.filename));
                }, { shared: true });
                followDraft(used);
                if (!attached) rejected.push({ name: file.name, reason: 'unsupported-type' });
            } catch {
                rejected.push({ name: file.name, reason: file.size > MAX_INLINE_ATTACHMENT_BYTES ? 'too-large' : 'unreadable' });
            } finally {
                reserved.delete(file.name);
            }
        };
        const attachAsIs = async (file: File, landedNames: string[]) => {
            const used = currentTarget();
            try {
                await addAttachedFile(file, used, (landed) => {
                    landedNames.push(...landed.map((entry) => entry.filename));
                }, { shared: true, saveOnSend: 'reference' });
                followDraft(used);
            } catch {
                rejected.push({ name: file.name, reason: file.size > MAX_ATTACHMENT_BYTES ? 'too-large' : 'unreadable' });
            } finally {
                reserved.delete(file.name);
            }
        };

        const usedNames = [
            ...useInputStore.getState().getAttachedFiles(currentTarget()).map((file) => file.filename),
            ...reserved,
            ...(isOnScreen() ? findImagePathCitationNames(composerRef.current?.getValue() ?? composerText.get()) : []),
        ];
        const images = files.filter((file) => file.type.startsWith('image/'));
        const others = files.filter((file) => !file.type.startsWith('image/'));
        const imageNames = assignImageAttachmentFilenames(images, usedNames);
        const otherNames = assignFileAttachmentFilenames(others, [...usedNames, ...imageNames]);
        const named = [
            ...images.map((file, index) => renameFileForAttachmentCitation(file, imageNames[index])),
            ...others.map((file, index) => (otherNames[index] === file.name ? file : renameFileForAttachmentCitation(file, otherNames[index]))),
        ];
        for (const file of named) reserved.add(file.name);

        const behavior = useUIStore.getState().documentAttachBehavior;
        const documents = behavior === 'convert' ? [] : named.filter((file) => isDocumentAttachmentFilename(file.name));
        const now = named.filter((file) => !documents.includes(file));

        const work = (async (): Promise<RejectedSharedFile[]> => {
            const landed: string[] = [];
            for (const file of now) await attachLocally(file, landed);
            place(landed, leadingText);

            if (documents.length === 0) return rejected;
            const attachDocuments = async (asIs: boolean) => {
                const landedDocuments: string[] = [];
                for (const file of documents) {
                    if (asIs) await attachAsIs(file, landedDocuments);
                    else await attachLocally(file, landedDocuments);
                }
                place(landedDocuments, '');
            };
            if (behavior === 'save' || !isOnScreen()) {
                await attachDocuments(true);
                return rejected;
            }
            await new Promise<void>((settle) => {
                let settled = false;
                const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
                largeTextPasteOfferIdRef.current = offerId;
                const finish = (asIs: boolean) => {
                    if (settled) return;
                    settled = true;
                    unsubscribe();
                    void attachDocuments(asIs).then(settle, settle);
                };
                const unsubscribe = useInputStore.subscribe((state) => {
                    if (state.attachmentDraftKey !== getChatDraftIdentityKey(currentTarget())) finish(true);
                });
                setLargeTextPasteOffer({
                    id: offerId,
                    kind: 'documents',
                    onDismiss: () => finish(true),
                    resolve: (action, explicitlyChosen, typedText) => {
                        const resolution = resolveLargeTextPasteOffer(largeTextPasteOfferIdRef.current, offerId, { explicitlyChosen });
                        largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                        if (!resolution.accepted) return;
                        finish(action === 'attach');
                        setLargeTextPasteOffer(null);
                        if (typedText) insertTextAtSelection(typedText);
                        if (resolution.restoreFocus) {
                            if (composerRef.current) composerRef.current.focus({ preventScroll: isCapacitorApp() });
                            else mobileShell.expand();
                        }
                    },
                });
                if (useUIStore.getState().isMobile && !mobileShell.expanded) mobileShell.expand();
            });
            return rejected;
        })();
        void trackAttachWork(work.then(() => undefined, () => undefined));
        return work;
    }, [addAttachedFile, composerRef, composerText, insertCitationAtSelection, insertTextAtSelection, largeTextPasteOfferIdRef, mobileShell, pendingPastedAttachmentFilenamesRef, setLargeTextPasteOffer, trackAttachWork]);

    const attachFilesWithCitation = React.useCallback((files: File[], leadingText: string = ''): Promise<void> => {
        const documents = files.filter((file) => isDocumentAttachmentFilename(file.name));
        const behavior = useUIStore.getState().documentAttachBehavior;
        if (documents.length === 0 || behavior === 'convert') return trackAttachWork(attachFilesWithCitationNow(files, leadingText));

        if (behavior === 'save') return trackAttachWork(attachFilesWithCitationNow(files, leadingText, true));
        const work = trackAttachWork(attachFilesWithCitationNow(files.filter((file) => !documents.includes(file)), leadingText));
        offerDocumentChoice(documents);
        return work;
    }, [attachFilesWithCitationNow, offerDocumentChoice, trackAttachWork]);

    return {
        attachFilesWithCitation, attachSharedFiles, insertCitationAtSelection,
    };
}
