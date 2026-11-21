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
import { MAX_ATTACHMENT_BYTES, useInputStore } from '@/sync/input-store';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { formatFileSize } from '@/lib/fileSize';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import { assignImageAttachmentFilenames, buildAttachmentCitationText, buildImagePathCitationText, findImagePathCitationNames, imageSaveModeForModel, prepareImageToSave, renameFileForAttachmentCitation } from '../../attachmentCitations';
import { assignFileAttachmentFilenames, attachmentsCitedIn } from '@/lib/attachmentIdentity';
import { buildImagePasteInsertion, withInlineInsertionBoundaries } from '../../composer/text';
import { getFileMentionInputSourceForInsertedText } from './composerMentionTokens';
import { isDocumentAttachmentFilename } from '@/sync/attachment-files';
import { isCapacitorApp } from '@/lib/platform';
import { beginLargeTextPasteOffer, resolveLargeTextPasteOffer } from '../../composer/largeTextPasteOffer';
import type { LargeTextPasteChoiceAction } from '../../composer/ui/LargeTextPasteChoice';

type Dependencies = {
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'pendingPastedAttachmentFilenamesRef' | 'pendingAttachWorkRef'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'insertTextAtSelection'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentModelMetadata' | 'currentModelId' | 'currentProviderId'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentDirectory' | 'addAttachedFile' | 'chatDraftIdentity' | 'attachedFiles'>;
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
    const { currentModelMetadata, currentModelId, currentProviderId } = selection;
    const { currentDirectory, addAttachedFile, chatDraftIdentity, attachedFiles } = sessionScope;
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

    const currentModelName = currentModelMetadata?.name ?? currentModelId ?? '';

    const currentModelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;

    const saveImagesWithPathCitation = React.useCallback(async (
        files: File[],
        leadingText: string,
        reservedNames: string[],
        mode: 'instead' | 'alongside',
    ): Promise<{ saved: File[]; attachable: File[]; unsaved: File[] }> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const names = assignImageAttachmentFilenames(files, [
            ...reservedNames,
            ...findImagePathCitationNames(composerRef.current?.getValue() ?? composerText.get()),
        ]);
        const images = files.map((file, index) => renameFileForAttachmentCitation(file, names[index]));
        const savingToastId = toast.loading(t('chat.chatInput.toast.imagesSaving', { files: images.map((file) => file.name).join(', ') }));
        const prepared = await Promise.all(images.map((file) => prepareImageToSave(file).catch(() => null)));
        const readable = prepared.filter((entry) => entry !== null);
        let results: Awaited<ReturnType<typeof opencodeClient.writeOpenCodeTempFiles>>;
        try {
            results = readable.length > 0
                ? await opencodeClient.writeOpenCodeTempFiles(currentDirectory, readable.map(({ filename, bytes }) => ({ filename, bytes })))
                : [];
        } catch (error) {
            results = readable.map(({ filename }) => ({ filename, error: error instanceof Error ? error : new Error(String(error)) }));
        }
        toast.dismiss(savingToastId);
        if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return { saved: [], attachable: [], unsaved: [] };

        const saved = results.flatMap((result) => 'path' in result ? [result] : []);
        const savedNames = new Set(saved.map((result) => result.filename));
        const isSaved = (index: number) => {
            const entry = prepared[index];
            return Boolean(entry && savedNames.has(entry.filename));
        };
        const unsaved = images.filter((_file, index) => !isSaved(index));
        if (results.some((result) => 'error' in result)) {
            console.warn('[chat] Saving an image failed', results.flatMap((result) => 'error' in result ? [result.error.name] : []));
        }

        if (saved.length > 0) {
            insertCitationAtSelection(buildImagePathCitationText(saved), leadingText);
            const firstPath = saved[0].path.replace(/\\/g, '/');
            const savedFiles = saved.map((result) => result.filename).join(', ');
            const folder = firstPath.slice(0, firstPath.lastIndexOf('/'));
            if (mode === 'alongside') {
                toast.info(t('chat.chatInput.toast.imagesSaved', { files: savedFiles, folder }), { id: `images-saved:${currentModelKey}` });
            } else {
                toast.info(t('chat.chatInput.toast.imagesSavedForTextModel', {
                    model: currentModelName,
                    files: savedFiles,
                    folder,
                }), unsaved.length > 0 ? undefined : { id: `attachment-modalities:${currentModelKey}` });
            }
        }
        if (unsaved.length > 0) {
            const files = unsaved.map((file) => file.name).join(', ');
            toast.error(mode === 'alongside'
                ? t('chat.chatInput.toast.imageCopySaveFailed', { files })
                : t('chat.chatInput.toast.imageSaveFailed', { files }));
        }
        return {
            saved: images.filter((_file, index) => isSaved(index)),
            attachable: images.filter((_file, index) => isSaved(index) && !prepared[index]?.linkOnly),
            unsaved,
        };
    }, [currentDirectory, currentModelKey, currentModelName, insertCitationAtSelection, t, composerText, composerRef]);

    const saveDocumentsWithPathCitation = React.useCallback(async (files: File[], attachmentDraftKey: string | null, isCurrentRuntime: () => boolean): Promise<void> => {
        const isCurrent = () => useInputStore.getState().attachmentDraftKey === attachmentDraftKey && isCurrentRuntime();
        if (!isCurrent()) return;
        const names = assignFileAttachmentFilenames(files.map((file) => ({ name: file.name.replace(/[<>]/g, '_') })), [
            ...useInputStore.getState().attachedFiles.map((file) => file.filename),
            ...pendingPastedAttachmentFilenamesRef.current,
            ...findImagePathCitationNames(composerRef.current?.getValue() ?? composerText.get()),
        ]);
        const writable = files.flatMap((file, index) => {
            if (file.size <= MAX_ATTACHMENT_BYTES) {
                return [{ filename: names[index], bytes: async () => new Uint8Array(await file.arrayBuffer()) }];
            }
            toast.error(t('chat.fileAttachment.toast.overSendLimit', { name: names[index], size: formatFileSize(MAX_ATTACHMENT_BYTES) }));
            return [];
        });
        if (writable.length === 0) return;
        const savingToastId = toast.loading(t('chat.chatInput.toast.imagesSaving', { files: writable.map(({ filename }) => filename).join(', ') }));
        let results: Awaited<ReturnType<typeof opencodeClient.writeOpenCodeTempFiles>>;
        try {
            results = await opencodeClient.writeOpenCodeTempFiles(currentDirectory, writable, { isCurrentRuntime });
        } catch (error) {
            results = writable.map(({ filename }) => ({ filename, error: error instanceof Error ? error : new Error(String(error)) }));
        }
        toast.dismiss(savingToastId);
        if (!isCurrent()) return;

        const saved = results.flatMap((result) => 'path' in result ? [result] : []);
        if (results.some((result) => 'error' in result)) {
            console.warn('[chat] Saving a document failed', results.flatMap((result) => 'error' in result ? [result.error.name] : []));
        }
        if (saved.length > 0) {
            insertCitationAtSelection(buildImagePathCitationText(saved), '');
            const firstPath = saved[0].path.replace(/\\/g, '/');
            toast.info(t('chat.chatInput.toast.imagesSaved', {
                files: saved.map((result) => result.filename).join(', '),
                folder: firstPath.slice(0, firstPath.lastIndexOf('/')),
            }));
        }
        const savedNames = new Set(saved.map((result) => result.filename));
        const failed = writable.map(({ filename }) => filename).filter((name) => !savedNames.has(name));
        if (failed.length > 0) toast.error(t('chat.chatInput.toast.imageCopySaveFailed', { files: failed.join(', ') }));
    }, [currentDirectory, insertCitationAtSelection, t, composerText, composerRef, pendingPastedAttachmentFilenamesRef]);

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
    ): Promise<void> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        let imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

        const insertCitation = (filenames: string[], text: string) => {
            insertCitationAtSelection(filenames.length > 0 ? buildAttachmentCitationText(filenames) : '', text);
        };

        const usedNames = () => [
            ...useInputStore.getState().attachedFiles.map((file) => file.filename),
            ...pendingPastedAttachmentFilenamesRef.current,
            ...findImagePathCitationNames(composerRef.current?.getValue() ?? composerText.get()),
        ];

        let savedAny = false;
        let attached = false;
        if (imageSaveMode !== 'attach' && imageFiles.length > 0) {
            const { saved, attachable, unsaved } = await saveImagesWithPathCitation(imageFiles, leadingText, usedNames(), imageSaveMode);
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
            if (saved.length > 0) {
                savedAny = true;
                leadingText = '';
            }
            if (imageSaveMode === 'alongside') {
                for (const file of attachable) {
                    try {
                        attached = (await addAttachedFile(file)) || attached;
                    } catch (error) {
                        console.error('Clipboard image attach failed', error);
                        toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
                    }
                    if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
                }
            }
            imageFiles = unsaved;
        }

        const assignedImageNames = assignImageAttachmentFilenames(imageFiles, usedNames());
        for (const filename of assignedImageNames) pendingPastedAttachmentFilenamesRef.current.add(filename);
        insertCitation(assignedImageNames, leadingText);

        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedImageNames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            try {
                attached = (await addAttachedFile(file, undefined, ([landed]) => {
                    if (landed && landed.filename.toLowerCase() !== filename.toLowerCase()) renameCitation(filename, landed.filename);
                })) || attached;
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
            try {
                let landedName = file.name;
                if (await addAttachedFile(file, undefined, ([landed]) => { if (landed) landedName = landed.filename; })) {
                    attached = true;
                    attachedOtherNames.push(landedName);
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

        if (files.length > 0 && !attached && !savedAny && !reported) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, imageSaveMode, insertCitationAtSelection, renameCitation, saveImagesWithPathCitation, t, composerText, composerRef, pendingPastedAttachmentFilenamesRef]);

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

    const offerDocumentChoice = React.useCallback((documents: File[], attachmentDraftKey: string | null, isCurrentRuntime: () => boolean) => {
        const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
        largeTextPasteOfferIdRef.current = offerId;
        const resolve = (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => {
            const resolution = resolveLargeTextPasteOffer(largeTextPasteOfferIdRef.current, offerId, { explicitlyChosen });
            largeTextPasteOfferIdRef.current = resolution.nextOfferId;
            if (!resolution.accepted) return;
            setLargeTextPasteOffer(null);
            void trackAttachWork(action === 'attach'
                ? saveDocumentsWithPathCitation(documents, attachmentDraftKey, isCurrentRuntime)
                : attachFilesWithCitationNow(documents));
            if (typedText) insertTextAtSelection(typedText);
            if (resolution.restoreFocus) {
                if (composerRef.current) composerRef.current.focus({ preventScroll: isCapacitorApp() });
                else mobileShell.expand();
            }
        };
        setLargeTextPasteOffer({ id: offerId, kind: 'documents', resolve });
        if (useUIStore.getState().isMobile && !mobileShell.expanded) mobileShell.expand();
    }, [attachFilesWithCitationNow, insertTextAtSelection, largeTextPasteOfferIdRef, mobileShell, saveDocumentsWithPathCitation, setLargeTextPasteOffer, trackAttachWork, composerRef]);

    const attachFilesWithCitation = React.useCallback((files: File[], leadingText: string = ''): Promise<void> => {
        const documents = files.filter((file) => isDocumentAttachmentFilename(file.name));
        const behavior = useUIStore.getState().documentAttachBehavior;
        if (documents.length === 0 || behavior === 'convert') return trackAttachWork(attachFilesWithCitationNow(files, leadingText));

        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const isCurrentRuntime = captureRuntimeInstance();
        const others = files.filter((file) => !documents.includes(file));
        if (behavior === 'save') {
            return trackAttachWork(attachFilesWithCitationNow(others, leadingText)
                .then(() => saveDocumentsWithPathCitation(documents, attachmentDraftKey, isCurrentRuntime)));
        }
        const work = trackAttachWork(attachFilesWithCitationNow(others, leadingText));
        offerDocumentChoice(documents, attachmentDraftKey, isCurrentRuntime);
        return work;
    }, [attachFilesWithCitationNow, offerDocumentChoice, saveDocumentsWithPathCitation, trackAttachWork]);

    return {
        attachFilesWithCitation, insertCitationAtSelection,
    };
}
