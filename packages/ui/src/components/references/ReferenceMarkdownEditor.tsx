
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
