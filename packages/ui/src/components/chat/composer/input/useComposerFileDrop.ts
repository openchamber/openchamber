import React from 'react';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { confirmMention } from '../../composer/language/mentions';
import { appendInlineText } from '../../composer/text';
import { collectDroppedFileUris, collectDroppedFiles, hasDraggedFiles } from '../../composer/attachments/dataTransfer';
import { normalizeDroppedPath } from '../../composer/attachments/filePaths';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerFileIntake } from './useComposerFileIntake';

type Dependencies = Pick<ReturnType<typeof useComposerEnvironment>, 'toMentionPath'>
    & Pick<ReturnType<typeof useComposerInputState>, 'confirmedMentionsRef' | 't' | 'dragEnterCountRef' | 'isInternalDrag' | 'setIsInternalDrag' | 'isDragging' | 'setIsDragging' | 'composerRef' | 'composerText' | 'cursorPosRef' | 'setMessage' | 'pendingDroppedAbsolutePathsRef' | 'suppressNextFileDropTextInsertRef'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'setPendingInputText' | 'currentSessionId' | 'newSessionDraftOpen'>
    & Pick<ReturnType<typeof useComposerSelection>, 'mailboxTarget'>
    & Pick<ReturnType<typeof useComposerEditorActions>, 'clearDropTextSuppression' | 'scheduleDropTextSuppressionExpiry'>
    & Pick<ReturnType<typeof useComposerFileIntake>, 'attachFilesWithCitation'>;

export function useComposerFileDrop({
    toMentionPath, confirmedMentionsRef, setPendingInputText, mailboxTarget, t, dragEnterCountRef,
    isInternalDrag, setIsInternalDrag, currentSessionId, newSessionDraftOpen, isDragging, setIsDragging,
    clearDropTextSuppression, composerRef, composerText, cursorPosRef, setMessage,
    pendingDroppedAbsolutePathsRef, attachFilesWithCitation, suppressNextFileDropTextInsertRef,
    scheduleDropTextSuppressionExpiry,
}: Dependencies) {
    const addVSCodeDroppedUrisAsMentions = React.useCallback((uris: string[]) => {
        if (uris.length === 0) return;

        const paths = uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toMentionPath(entry))
            .map((entry) => entry.trim().replace(/^\.\//, ''))
            .filter((entry) => entry.length > 0);

        for (const p of paths) {
            confirmMention(p, confirmedMentionsRef.current);
        }

        const mentions = Array.from(new Set(paths.map((entry) => `@${entry}`)));

        if (mentions.length === 0) {
            return;
        }

        setPendingInputText(mentions.join(' '), 'append-inline', mailboxTarget);
        toast.success(t('chat.chatInput.toast.addedFileMentions', { count: mentions.length }));
    }, [mailboxTarget, setPendingInputText, t, toMentionPath, confirmedMentionsRef]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-openchamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setIsInternalDrag(false);
            clearDropTextSuppression();
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setIsInternalDrag(false);
        clearDropTextSuppression();
    };

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-openchamber-file-path');
        if (internalPath && internalPath !== '.') {
            confirmMention(internalPath, confirmedMentionsRef.current);
            const mention = `@${internalPath}`;
            const textarea = composerRef.current;
            const currentMessage = composerText.get();
            if (textarea) {
                const { start: pos, end } = textarea.getSelection();
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                // Insert through the editor rather than setMessage: an editor
                // dispatch places the caret right after the mention, while the
                // external-rewrite path would send it to the end of the
                // message and pin the scroll to the bottom.
                textarea.replaceRange(pos, end, insert);
                cursorPosRef.current = pos + insert.length;
                textarea.focus();
            } else {
                setMessage(appendInlineText(composerText.get(), mention));
            }
            clearDropTextSuppression();
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length === 0 && isVSCodeRuntime()) {
            const droppedUris = collectDroppedFileUris(e.dataTransfer);
            if (droppedUris.length > 0) {
                pendingDroppedAbsolutePathsRef.current = droppedUris
                    .map((entry) => normalizeDroppedPath(entry))
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0);
                addVSCodeDroppedUrisAsMentions(droppedUris);
            } else {
                clearDropTextSuppression();
            }
            return;
        }

        if (files.length > 0) {
            await attachFilesWithCitation(files);
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
        if (isVSCodeRuntime()) {
            suppressNextFileDropTextInsertRef.current = true;
            scheduleDropTextSuppressionExpiry();
        }
    };

    return {
        handleDropCapture, handleDragEnter, handleDragOver, handleDragLeave, handleDrop, handleDragEnd,
    };
}
