/**
 * The composer editor's layout, typography and caret.
 *
 * Token colours are not here: they come from the shared highlight classes the
 * language layer emits, so the composer and the message list stay in step.
 */

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Exported for the regression test, which asserts the caret is styled where it
 * is actually drawn.
 */
export const COMPOSER_EDITOR_THEME_SPEC = {
    '&': {
        backgroundColor: 'transparent',
        color: 'var(--surface-foreground)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
        padding: '0',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        // The content box must cover the whole editor, not just the text, so
        // clicking the empty space below the last line still lands in it.
        minHeight: '100%',
    },
    // The caret is NOT the native one. `drawSelection()` hides that with
    // `caret-color: transparent !important` at the highest precedence and
    // draws its own `.cm-cursor` element, whose base style is a hard-coded
    // `border-left: 1.2px solid black`. Styling `caret-color` here therefore
    // does nothing at all — the border is what has to be coloured. A 2px
    // stroke makes the insertion point remain visible against every composer
    // surface without relying on a fixed colour. A slight vertical scale makes
    // it extend beyond the glyphs without changing CodeMirror's line geometry.
    //
    // CodeMirror recolours it for dark editors through `&dark .cm-cursor`,
    // which needs the theme to declare itself dark. OpenChamber themes are not
    // only light or dark, so the cursor takes the surface foreground directly
    // instead. `&.cm-editor` matches the specificity of that `&dark` rule, and
    // theme styles mount after the base theme, so this wins in every variant.
    //
    // The `&light` / `&dark` scopes are NOT usable here: EditorView.theme
    // builds its selectors without scopes and throws RangeError on them the
    // moment this module is imported.
    '&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor': {
        borderLeftColor: 'var(--surface-foreground)',
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
    // Kebab-case: the theme emits `--surface-muted-foreground`. A camelCased
    // name here is not a missing colour but an invalid declaration, and since
    // `color` inherits, the placeholder silently renders at full text
    // brightness instead.
    '.cm-placeholder': { color: 'var(--surface-muted-foreground)' },
    // `drawSelection()` paints its own selection layer, and CodeMirror styles
    // it for the focused editor through
    // `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
    // — six classes deep, so anything shorter loses and the selection comes out
    // in CodeMirror's stock lavender. Both rules below match the shape of the
    // ones they replace: unfocused first, then the focused case.
    //
    // The tint is translucent on purpose. An opaque selection would bury the
    // token colours the composer exists to show; the point of selecting text
    // here is to move it, not to stop reading it.
    '&.cm-editor .cm-selectionBackground, & .cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--interactive-selection) 45%, transparent)',
    },
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--interactive-selection) 55%, transparent)',
    },
};

export const composerEditorTheme = EditorView.theme(COMPOSER_EDITOR_THEME_SPEC);

/**
 * Outside CodeMirror's iOS branch, devices keep `drawSelection()` but show the
 * NATIVE selection through it, for two independent reasons:
 *
 * - Their selection drag handles (the draggable pins after a double-tap)
 *   attach to the *visible* native selection, and `drawSelection()`
 *   hides it with `.cm-line ::selection { background: transparent
 *   !important }`, so the handles never appear and range selection is
 *   undiscoverable.
 * - The painted selection layer sits *behind* the content, so any token with
 *   its own background — inline code, code fences — covers it completely and
 *   the selection is invisible inside those spans. The native selection
 *   paints over element backgrounds.
 *
 * Dropping `drawSelection()` entirely is NOT an option, on any platform:
 * without it CodeMirror clears the `nativeSelectionHidden` facet and starts
 * enforcing cursor association on the native selection while typing in
 * wrapped text — programmatic selection moves that iOS answers with severe
 * input lag (each one also resets the keyboard's autocorrect context). Typing
 * must stay on the drawn-selection code path; only the paint changes.
 *
 * CodeMirror's iOS branch does NOT use this arrangement —
 * `composerIOSSelectionExtension` below explains why.
 *
 * Both rules below fight `drawSelection()`'s own `Prec.highest` theme, so
 * they carry `!important` and one class more specificity
 * (`.cm-content .cm-line` vs its `.cm-line`) to win regardless of style
 * mount order. The painted selection layer is hidden rather than removed —
 * two highlights would otherwise stack.
 */
export const NATIVE_SELECTION_THEME_SPEC = {
    // Built from `--primary`, not `--interactive-selection`: themes define the
    // selection token with its own alpha (often under 10%), so mixing it with
    // transparent again leaves the highlight barely perceptible. `--primary`
    // is a full-strength colour in every theme; a low mix of it reads as a
    // classic editor selection while the token colours stay legible through it.
    '& .cm-content .cm-line ::selection, & .cm-content .cm-line::selection': {
        backgroundColor:
            'color-mix(in srgb, var(--primary) 25%, transparent) !important',
    },
    // iOS derives the colour of its selection UI — the drag handles included —
    // from the caret colour, and `drawSelection()` sets `caret-color:
    // transparent !important` on both `.cm-content` and `.cm-line`. A visible
    // native selection alone is therefore not enough: the handles get drawn,
    // in transparent.
    //
    // But a visible native caret is not free either: while it shows, WebKit
    // re-renders its caret UI after every keystroke's decoration redraw, which
    // arrives as severe input lag. The handles only exist while a RANGE is
    // selected — exactly when there is no caret — so the native caret (and the
    // drawn cursor layer's absence) are scoped to `.oc-native-range`, which
    // `composerNativeSelectionExtension` sets on the editor whenever the main
    // selection is non-empty. Typing stays on the transparent-native-caret
    // fast path.
    '&.cm-editor.oc-native-range .cm-content, &.cm-editor.oc-native-range .cm-content .cm-line': {
        caretColor: 'var(--surface-foreground) !important',
    },
    '&.oc-native-range .cm-scroller > .cm-cursorLayer': {
        display: 'none',
    },
    // The layers live beside the content, as children of the scroller.
    '& .cm-scroller > .cm-selectionLayer': {
        display: 'none',
    },
};

const composerNativeSelectionTheme = EditorView.theme(NATIVE_SELECTION_THEME_SPEC);

/**
 * The native-selection arrangement, installed outside CodeMirror's iOS branch:
 * the theme above plus the `.oc-native-range` marker class that scopes its
 * caret rules to the moments a range is actually selected. `editorAttributes`
 * re-evaluates on every update, so the class follows the selection with no
 * listener of its own.
 */
export const composerNativeSelectionExtension: Extension = [
    composerNativeSelectionTheme,
    EditorView.editorAttributes.of((view) =>
        view.state.selection.main.empty ? null : { class: 'oc-native-range' }),
];

/**
 * When its iOS predicate matches, CodeMirror 6.43.9 draws the range handles
 * into the same layer as the selection, so CodeMirror owns both their geometry
 * and appearance.
 *
 * That layer normally renders at `z-index: -1`, behind the content. Inline
 * code and code fences have opaque backgrounds and would cover both the tint
 * and handles. Raising the one existing layer fixes that without introducing
 * a second set of rectangles or trying to imitate WebKit's controls. The
 * layer remains transparent to touch so WebKit receives selection gestures.
 *
 * What iOS avoids is the native-selection workaround above: explicitly
 * restoring the native highlight and caret makes WebKit re-measure and repaint
 * that UI after every decoration redraw. `composerLanguage.ts` rebuilds the
 * whole decoration set on every keystroke, so the cost is felt worst during
 * IME composition where each intermediate replacement pays for it. WebKit's
 * unavoidable system selection overlay remains the only visible fill.
 */
export const IOS_SELECTION_THEME_SPEC = {
    // The handles extend 8px above/below their range. The scroller clips them
    // at its own edge even when the layer has a high z-index, so reserve that
    // room inside the clipping box and pull the box outward by the same amount.
    // Text and composer height stay where they were; only the clip area grows.
    '& .cm-scroller': {
        marginBlock: '-8px',
        paddingBlock: '8px',
    },
    '& .cm-scroller > .cm-selectionLayer': {
        // CodeMirror writes `z-index: -1` inline. `!important` is intentional:
        // without it token backgrounds cover the selection and its handles.
        zIndex: '100 !important',
        pointerEvents: 'none',
    },
    // iOS keeps showing its taller system selection overlay even when
    // ::selection is transparent. Painting CodeMirror's themed rectangles as
    // well produces two visibly misaligned fills, so only the synthetic
    // background is suppressed. The handles in this layer remain visible.
    '& .cm-selectionBackground': {
        background: 'transparent !important',
    },
};

export const composerIOSSelectionExtension: Extension =
    EditorView.theme(IOS_SELECTION_THEME_SPEC);

/**
 * Which selection paint the composer installs. The split is the platform's,
 * not a preference: iOS is the one place where restoring native selection
 * paint and caret costs measurable input latency, and the only place
 * CodeMirror supplies replacement drag handles.
 *
 * The caller can pass the policy, so the choice stays testable and is made
 * once per editor rather than once per module load.
 */
export function composerSelectionExtension(
    useCodeMirrorIOSHandles: boolean = usesCodeMirrorIOSSelectionHandles(),
): Extension {
    return useCodeMirrorIOSHandles
        ? composerIOSSelectionExtension
        : composerNativeSelectionExtension;
}

/**
 * Mirrors @codemirror/view 6.43.9's iOS predicate. This branch may only rely
 * on the drawn handles when CodeMirror itself will create them; a broader iOS
 * heuristic could remove the native fallback without installing a replacement.
 */
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
