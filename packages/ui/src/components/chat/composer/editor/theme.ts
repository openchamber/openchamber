
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';


export const COMPOSER_EDITOR_THEME_SPEC = {
    '&': {
        backgroundColor: 'transparent',
        color: 'var(--oc-composer-foreground, var(--surface-elevated-foreground))',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
        padding: '0',
        paddingInlineStart: '1px',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        minHeight: '100%',
        minWidth: '0',
    },
    '&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor': {
        borderLeftColor: 'var(--oc-composer-foreground, var(--surface-elevated-foreground))',
        borderLeftWidth: '2px',
        transform: 'scaleY(1.15)',
        transformOrigin: 'center',
    },
    '.cm-line': { padding: '0' },
    '.cm-scroller': {
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        overflowX: 'hidden',
    },
    '& .cm-content.cm-composer-empty .cm-line': { position: 'relative' },
    '& .cm-content.cm-composer-empty .cm-line::before': {
        content: 'var(--composer-placeholder)',
        color: 'var(--surface-muted-foreground)',
        opacity: '0.6',
        position: 'absolute',
        insetInlineStart: '0',
        top: '0',
        userSelect: 'none',
        pointerEvents: 'none',
    },
    '&.cm-editor .cm-selectionBackground, & .cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--interactive-selection) 45%, transparent)',
    },
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--interactive-selection) 55%, transparent)',
    },
};

// external: #7096 Chromium on Android reads text a `::before` paints inside an editable as the field's own text.
// external: https://github.com/marijnh/style-mod/blob/main/src/style-mod.js style-mod expands `&` inside an @-block against the @-rule, so this selector gets the theme scope only without one.
const PLACEHOLDER_ALT_TEXT_SPEC = {
    '@supports (content: "" / "")': {
        '.cm-content.cm-composer-empty .cm-line::before': {
            content: 'var(--composer-placeholder) / ""',
        },
    },
};

export const composerEditorTheme = EditorView.theme({
    ...COMPOSER_EDITOR_THEME_SPEC,
    ...PLACEHOLDER_ALT_TEXT_SPEC,
});

export const NATIVE_SELECTION_THEME_SPEC = {
    '& .cm-content .cm-line ::selection, & .cm-content .cm-line::selection': {
        backgroundColor:
            'var(--interactive-selection) !important',
        color: 'var(--interactive-selection-foreground) !important',
    },
    '&.cm-editor.oc-native-range .cm-content, &.cm-editor.oc-native-range .cm-content .cm-line': {
        caretColor: 'var(--oc-composer-foreground, var(--surface-elevated-foreground)) !important',
    },
    '&.oc-native-range .cm-scroller > .cm-cursorLayer': {
        display: 'none',
    },
    '& .cm-scroller > .cm-selectionLayer': {
        display: 'none',
    },
};

const composerNativeSelectionTheme = EditorView.theme(NATIVE_SELECTION_THEME_SPEC);

export const composerNativeSelectionExtension: Extension = [
    composerNativeSelectionTheme,
    EditorView.editorAttributes.of((view) =>
        view.state.selection.main.empty ? null : { class: 'oc-native-range' }),
];

export const IOS_SELECTION_THEME_SPEC = {
    '& .cm-scroller': {
        marginBlock: '-8px',
        paddingBlock: '8px',
    },
    '& .cm-scroller > .cm-selectionLayer': {
        zIndex: '100 !important',
        pointerEvents: 'none',
    },
    '& .cm-selectionBackground': {
        background: 'transparent !important',
    },
};

export const composerIOSSelectionExtension: Extension =
    EditorView.theme(IOS_SELECTION_THEME_SPEC);

export function composerSelectionExtension(
    useCodeMirrorIOSHandles: boolean = usesCodeMirrorIOSSelectionHandles(),
): Extension {
    return useCodeMirrorIOSHandles
        ? composerIOSSelectionExtension
        : composerNativeSelectionExtension;
}

// external: https://code.haverbeke.berlin/codemirror/view/src/tag/6.43.15/src/browser.ts Selection handles require CodeMirror's exact iOS predicate.
export function isCodeMirrorIOSNavigator(
    userAgent: string,
    vendor: string,
    maxTouchPoints: number,
): boolean {
    const isIE = /Edge\/(\d+)/.test(userAgent)
        || /MSIE \d/.test(userAgent)
        || /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.test(userAgent);
    if (isIE || !/Apple Computer/.test(vendor)) return false;
    return /Mobile\/\w+/.test(userAgent) || maxTouchPoints > 2;
}

function usesCodeMirrorIOSSelectionHandles(): boolean {
    const nav = globalThis.navigator;
    if (!nav) return false;
    return isCodeMirrorIOSNavigator(
        nav.userAgent || '',
        nav.vendor || '',
        nav.maxTouchPoints ?? 0,
    );
}
