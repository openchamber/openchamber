import React from 'react';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerLanguageContext } from '@/components/chat/composer/language/tokenize';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useInputStore } from '@/sync/input-store';
import type { CommentImagePaste } from './useCommentImagePaste';
import { useCommentFieldPicker } from './useCommentFieldPicker';
import { useCommentEnterSubmit } from './useCommentEnterSubmit';

const EMPTY_NAMES: ReadonlySet<string> = new Set();

export interface CommentTextEditorProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    enterSubmits: boolean;
    imagePaste: CommentImagePaste;
    placeholder: string;
    onBlur?: () => void;
    maxLines?: number;
    className?: string;
    'aria-label'?: string;
}

export function CommentTextEditor({
    value,
    onChange,
    onSubmit,
    onCancel,
    enterSubmits,
    imagePaste,
    placeholder,
    onBlur,
    maxLines = 5,
    className,
    'aria-label': ariaLabel,
}: CommentTextEditorProps) {
    const editorRef = React.useRef<ComposerEditorHandle>(null);

    const snippets = useSnippetsStore((state) => state.snippets);
    const attachedFiles = useInputStore((state) => state.attachedFiles);
    const themeVariant = useOptionalThemeSystem()?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
    const { pendingFilenames } = imagePaste;
    const languageContext = React.useMemo<ComposerLanguageContext>(() => {
        const knownSnippetTriggers = new Set<string>();
        for (const snippet of snippets) {
            knownSnippetTriggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) knownSnippetTriggers.add(alias.toLowerCase());
        }
        return {
            inputMode: 'normal',
            knownAgentNames: EMPTY_NAMES,
            confirmedMentions: EMPTY_NAMES,
            knownSlashNames: EMPTY_NAMES,
            knownSnippetTriggers,
            attachmentFilenames: attachedFiles.map((file) => file.filename),
            pendingAttachmentFilenames: pendingFilenames,
            fileIconVariant: themeVariant,
        };
    }, [attachedFiles, pendingFilenames, snippets, themeVariant]);

    const getCaret = React.useCallback(() => editorRef.current?.getSelection().start ?? 0, []);
    const replaceRange = React.useCallback((from: number, to: number, insert: string) => {
        editorRef.current?.replaceRange(from, to, insert);
        editorRef.current?.focus();
    }, []);
    const caretCoords = React.useCallback((position: number) => editorRef.current?.caretCoords(position) ?? null, []);
    const fieldPicker = useCommentFieldPicker({ text: value, getCaret, replaceRange, caretCoords });
    const commentKeys = useCommentEnterSubmit(enterSubmits);

    React.useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus({ preventScroll: true });
        editor.setSelection(editor.getValue().length);
    }, []);

    const handleKeyDown = (event: KeyboardEvent): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (fieldPicker.handleKeyDown(event)) return true;
        if (event.key === 'Enter' && commentKeys.shouldSubmit(event)) {
            event.preventDefault();
            onSubmit();
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return true;
        }
        return false;
    };

    const handlePaste = (event: ClipboardEvent) => {
        const editor = editorRef.current;
        if (!editor || !event.clipboardData) return;
        const pasted = imagePaste.takePastedImages(event.clipboardData, editor.getValue(), editor.getSelection());
        if (!pasted) return;
        event.preventDefault();
        editor.replaceRange(pasted.from, pasted.to, pasted.insertion);
    };

    return (
        <div className={cn('relative min-w-0 flex-1', className)}>
            {fieldPicker.picker}
            <ComposerEditor
                ref={editorRef}
                dataChatInput="comment"
                value={value}
                languageContext={languageContext}
                onChange={(change) => {
                    onChange(change.value);
                    fieldPicker.sync(change.value, change.selection.start, !change.fromPaste && !change.fromValueProp);
                }}
                onSelectionChange={(selection) => fieldPicker.sync(editorRef.current?.getValue() ?? value, selection.start, false)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onBlur={onBlur}
                returnKeySends={commentKeys.returnKeySends}
                preserveDeferredEnterShift={commentKeys.preserveDeferredEnterShift}
                placeholder={placeholder}
                spellCheck
                maxLines={maxLines}
                aria-label={ariaLabel ?? placeholder}
            />
        </div>
    );
}
