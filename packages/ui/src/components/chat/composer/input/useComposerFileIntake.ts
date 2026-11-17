import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import { assignImageAttachmentFilenames, buildAttachmentCitationText, buildImagePathCitationText, findImagePathCitationNames, imageSaveModeForModel, prepareImageToSave, renameFileForAttachmentCitation } from '../../attachmentCitations';
import { assignFileAttachmentFilenames, attachmentsCitedIn } from '@/lib/attachmentIdentity';
import { buildImagePasteInsertion, withInlineInsertionBoundaries } from '../../composer/text';
import { getFileMentionInputSourceForInsertedText } from './composerMentionTokens';

type Dependencies = {
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'pendingPastedAttachmentFilenamesRef' | 'pendingAttachWorkRef'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'insertTextAtSelection'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentModelMetadata' | 'currentModelId' | 'currentProviderId'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentDirectory' | 'addAttachedFile' | 'chatDraftIdentity' | 'attachedFiles'>;
};

export function useComposerFileIntake({
    editorState, draftText, i18n, attachmentWork, editorActions, selection, sessionScope,
}: Dependencies) {
    const { composerRef } = editorState;
    const { composerText } = draftText;
    const { t } = i18n;
    const { pendingPastedAttachmentFilenamesRef, pendingAttachWorkRef } = attachmentWork;
    const { insertTextAtSelection } = editorActions;
    const { currentModelMetadata, currentModelId, currentProviderId } = selection;
    const { currentDirectory, addAttachedFile, chatDraftIdentity, attachedFiles } = sessionScope;

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

    /**
     * Saves the images where OpenCode runs and cites each saved one in the
     * draft as `[name](path)`, so the model, a subagent or a tool opens it by
     * path: in place of the attachment for a model that takes no images
     * (#5087), next to it for one that does (#5218). Each image gets a name no
     * attachment or link in the draft uses yet. Answers both groups under
     * those names; the caller attaches the unsaved ones as before, and in
     * `alongside` the `attachable` saved ones too. A HEIC saved unconverted
     * gets only its link (`prepareImageToSave`).
     */
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
        // A cold or remote OpenCode can take seconds; this toast says what is going on.
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
            // The error text can carry the path; the name says what failed.
            console.warn('[chat] Saving an image failed', results.flatMap((result) => 'error' in result ? [result.error.name] : []));
        }

        if (saved.length > 0) {
            insertCitationAtSelection(buildImagePathCitationText(saved), leadingText);
            const firstPath = saved[0].path.replace(/\\/g, '/');
            const savedFiles = saved.map((result) => result.filename).join(', ');
            const folder = firstPath.slice(0, firstPath.lastIndexOf('/'));
            if (mode === 'alongside') {
                // One toast for a run of pastes; the newest names the latest folder.
                toast.info(t('chat.chatInput.toast.imagesSaved', { files: savedFiles, folder }), { id: `images-saved:${currentModelKey}` });
            } else {
                // When some failed, the modality warning for those (attached next)
                // takes the shared id, so this toast keeps its own.
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

    /**
     * Attach files that arrived by paste or drop and cite each one in the
     * draft as `[name]`, the same way pasted images are cited. Images get a
     * generated unique name up front; other files keep their own name and are
     * cited only once they attached, so a rejected file leaves no dangling
     * citation.
     */
    /** Points a chip at its file's new name, where intake renamed the file. */
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

        // With the setting on, links to saved images keep their names too, so an
        // attachment after a failed save never repeats one.
        const usedNames = () => [
            ...useInputStore.getState().attachedFiles.map((file) => file.filename),
            ...pendingPastedAttachmentFilenamesRef.current,
            ...(savePastedImagesAsFiles ? findImagePathCitationNames(composerRef.current?.getValue() ?? composerText.get()) : []),
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
                // The links already name these, so they attach without a second citation.
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
        // Pending before the text lands, so the editor draws the citation as a
        // chip in the same transaction that inserts it.
        for (const filename of assignedImageNames) pendingPastedAttachmentFilenamesRef.current.add(filename);
        insertCitation(assignedImageNames, leadingText);

        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedImageNames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            try {
                // Intake can rename the file (a HEIC becomes a JPEG): its chip follows.
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
                // The draft changed under the paste: the rest never attach here.
                for (const rest of assignedImageNames.slice(index + 1)) pendingPastedAttachmentFilenamesRef.current.delete(rest);
                return;
            }
        }

        const attachedOtherNames: string[] = [];
        let reported = false;
        // Each chip names one attachment, so a name already taken gets `-2`.
        const otherNames = assignFileAttachmentFilenames(otherFiles, usedNames());
        for (let index = 0; index < otherFiles.length; index += 1) {
            const file = otherNames[index] === otherFiles[index].name
                ? otherFiles[index]
                : renameFileForAttachmentCitation(otherFiles[index], otherNames[index]);
            try {
                // The chip names the file as intake kept it, which can differ from the picked name.
                let landedName = file.name;
                if (await addAttachedFile(file, undefined, ([landed]) => { if (landed) landedName = landed.filename; })) {
                    attached = true;
                    attachedOtherNames.push(landedName);
                }
            } catch (error) {
                console.error('File attach failed', error);
                // The store names the cause (a file too large to attach).
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
    }, [addAttachedFile, imageSaveMode, insertCitationAtSelection, renameCitation, savePastedImagesAsFiles, saveImagesWithPathCitation, t, composerText, composerRef, pendingPastedAttachmentFilenamesRef]);

    // VS Code adds files from outside the composer (the open-file suggestion,
    // the editor's and the explorer's "add to chat"); each new one gets its
    // chip at the caret. The files a draft already had when it came on screen
    // are its own and keep the chips its text has.
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

    // A send waits for files still being read: their chips are in the text,
    // and a send includes only attached files the text cites.
    const attachFilesWithCitation = React.useCallback((files: File[], leadingText: string = ''): Promise<void> => {
        const work = attachFilesWithCitationNow(files, leadingText);
        pendingAttachWorkRef.current.add(work);
        const settle = () => { pendingAttachWorkRef.current.delete(work); };
        work.then(settle, settle);
        return work;
    }, [attachFilesWithCitationNow, pendingAttachWorkRef]);

    return {
        attachFilesWithCitation, insertCitationAtSelection,
    };
}
