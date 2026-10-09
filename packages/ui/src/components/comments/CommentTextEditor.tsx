/**
 * The text field of desktop comment surfaces in ordinary page DOM: chat quote
 * comments and editing a pending comment above the composer. Line comments
 * inside the diff viewer and the file editor use `InlineCommentInput`'s
 * textarea instead (see the composer DOCUMENTATION.md).
 *
 * It is the composer's own editor with comment policy on top, so a comment
 * reads like the prompt it ends up in: pasted images show as file chips,
 * `#snippet` references as snippet chips, Markdown is highlighted. Agents,
 * commands and file mentions do not resolve in a comment.
 *
 * Keys: Enter submits (Shift+Enter breaks the line; with `enterSubmits` off,
 * as on touch, only Cmd/Ctrl+Enter submits), Escape cancels. Both wait for an
 * IME composition to finish, since Enter and Escape also confirm or abandon a
 * candidate.
 */

import React from 'react';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerLanguageContext } from '@/components/chat/composer/language/tokenize';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useInputStore } from '@/sync/input-store';
import type { CommentImagePaste } from './useCommentImagePaste';
import { useCommentSnippetPicker } from './useCommentSnippetPicker';

const EMPTY_NAMES: ReadonlySet<string> = new Set();

export interface CommentTextEditorProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    /** Bare Enter submits. Off on touch, where Enter breaks the line. */
    enterSubmits: boolean;
    /** The host's paste state: it attaches the cited images when the comment is saved. */
    imagePaste: CommentImagePaste;
    placeholder: string;
    onBlur?: () => void;
    /** Lines shown before the field scrolls. */
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

    // `#` opens the composer's snippet picker; references expand on send.
    const getCaret = React.useCallback(() => editorRef.current?.getSelection().start ?? 0, []);
    const replaceRange = React.useCallback((from: number, to: number, insert: string) => {
        editorRef.current?.replaceRange(from, to, insert);
        editorRef.current?.focus();
    }, []);
    const snippetPicker = useCommentSnippetPicker({ text: value, getCaret, replaceRange });

    // Every surface opens its field ready to type, caret after any text the
    // comment started with (a keystroke that opened it, or the saved comment).
    React.useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus({ preventScroll: true });
        editor.setSelection(editor.getValue().length);
    }, []);

    const handleKeyDown = (event: KeyboardEvent): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (snippetPicker.handleKeyDown(event)) return true;
        if (event.key === 'Enter' && !event.shiftKey && (enterSubmits || event.metaKey || event.ctrlKey)) {
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

    // A pasted image becomes a citation; the editor draws it as a chip.
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
            {snippetPicker.picker}
            <ComposerEditor
                ref={editorRef}
                dataChatInput="comment"
                value={value}
                languageContext={languageContext}
                onChange={(change) => {
                    onChange(change.value);
                    snippetPicker.sync(change.value, change.selection.start);
                }}
                onSelectionChange={(selection) => snippetPicker.sync(editorRef.current?.getValue() ?? value, selection.start)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onBlur={onBlur}
                placeholder={placeholder}
                spellCheck
                maxLines={maxLines}
                aria-label={ariaLabel ?? placeholder}
            />
        </div>
    );
}
