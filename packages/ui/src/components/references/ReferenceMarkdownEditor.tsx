/**
 * A host item's text is Markdown source, so it is edited in the composer's
 * editor: the same highlighting and code blocks as a prompt, with none of the
 * prompt's tokens resolving. `@name` stays the host's user, and a file path is
 * not a workspace file. Enter breaks the line; Mod+Enter saves, Escape cancels.
 * Pasted images are not taken, because a source-control write has nowhere to
 * put an upload.
 */

import * as React from 'react';

import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import type { ComposerLanguageContext } from '@/components/chat/composer/language/tokenize';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { isIMECompositionEvent } from '@/lib/ime';

const NO_NAMES: ReadonlySet<string> = new Set();

interface ReferenceMarkdownEditorProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    placeholder: string;
    disabled?: boolean;
    /** Opens ready to type; a description leaves the title's own field the focus. */
    autoFocus?: boolean;
    maxLines?: number;
    'aria-label'?: string;
}

export const ReferenceMarkdownEditor: React.FC<ReferenceMarkdownEditorProps> = ({
    value, onChange, onSubmit, onCancel, placeholder, disabled = false, autoFocus = false, maxLines = 6, 'aria-label': ariaLabel,
}) => {
    const editorRef = React.useRef<ComposerEditorHandle>(null);
    const themeVariant = useOptionalThemeSystem()?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode: 'normal',
        knownAgentNames: NO_NAMES,
        confirmedMentions: NO_NAMES,
        knownSlashNames: NO_NAMES,
        knownSnippetTriggers: NO_NAMES,
        attachmentFilenames: [],
        fileIconVariant: themeVariant,
    }), [themeVariant]);

    // An edit opens ready to type, the caret after the text it starts with.
    React.useLayoutEffect(() => {
        if (!autoFocus) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus({ preventScroll: true });
        editor.setSelection(editor.getValue().length);
    }, [autoFocus]);

    const handleKeyDown = (event: KeyboardEvent): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return true;
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
            return true;
        }
        return false;
    };

    return (
        <ComposerEditor
            ref={editorRef}
            dataChatInput="reference-body"
            value={value}
            languageContext={languageContext}
            onChange={(change) => onChange(change.value)}
            onKeyDown={handleKeyDown}
            editable={!disabled}
            placeholder={placeholder}
            spellCheck
            maxLines={maxLines}
            aria-label={ariaLabel ?? placeholder}
        />
    );
};
