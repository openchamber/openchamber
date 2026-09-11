import { describe, expect, test } from 'bun:test';
import { EditorState, type Extension } from '@codemirror/state';

import {
    COMPOSER_EDITOR_THEME_SPEC,
    IOS_SELECTION_THEME_SPEC,
    NATIVE_SELECTION_THEME_SPEC,
    composerEditorTheme,
    composerIOSSelectionExtension,
    composerNativeSelectionExtension,
    composerSelectionExtension,
    isCodeMirrorIOSNavigator,
} from '../theme';

const selectors = Object.keys(COMPOSER_EDITOR_THEME_SPEC);
const declarations = JSON.stringify(COMPOSER_EDITOR_THEME_SPEC);

function installationError(extension: Extension): string | null {
    try {
        EditorState.create({ extensions: [extension] });
        return null;
    } catch (error) {
        return String(error);
    }
}

describe('composerEditorTheme', () => {
    /**
     * EditorView.theme compiles its selectors when this module is imported and
     * throws RangeError on a scope it was not given — `&light` and `&dark`
     * among them, despite both appearing throughout CodeMirror's own base
     * theme. A build and a type-check both pass happily on that mistake; it
     * surfaces only in the running app, where it takes the composer down.
     */
    test('its selectors compile and the theme can be installed', () => {
        expect(installationError(composerEditorTheme)).toBeNull();
    });

    /**
     * The composer runs `drawSelection()`, which hides the native caret with
     * `caret-color: transparent !important` and draws a `.cm-cursor` element
     * instead. Styling `caret-color` looks correct and does nothing, leaving
     * CodeMirror's hard-coded black cursor on dark themes.
     */
    test('the caret is coloured where it is drawn, not on the native caret', () => {
        expect(selectors.some((selector) => selector.includes('.cm-cursor'))).toBe(true);
        expect(declarations.includes('caretColor')).toBe(false);
    });

    test('the drawn caret follows the theme rather than a fixed colour', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        const rule = (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[cursorRule!];
        expect(rule.borderLeftColor.startsWith('var(--')).toBe(true);
    });

    test('the drawn caret is wide enough to remain prominent', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        const rule = (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[cursorRule!];
        expect(rule.borderLeftWidth).toBe('2px');
        expect(rule.transform).toBe('scaleY(1.15)');
        expect(rule.transformOrigin).toBe('center');
    });

    /**
     * CodeMirror's own `.cm-cursor` rule and its `&dark` override are one and
     * two classes deep respectively; a bare `.cm-cursor` selector loses to the
     * latter. `&.cm-editor` matches it.
     */
    test('the caret rule is specific enough to beat the base theme', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        expect(cursorRule!.startsWith('&.cm-editor')).toBe(true);
    });

    /**
     * Same trap as the caret, one layer over: `drawSelection()` paints its own
     * selection and CodeMirror styles the focused case through a six-class
     * selector. A shorter rule silently loses and the selection renders in
     * CodeMirror's stock lavender, which buries the token colours.
     */
    test('the focused selection is styled at the depth CodeMirror uses', () => {
        const focusedRule = selectors.find((selector) =>
            selector.includes('.cm-focused') && selector.includes('.cm-selectionBackground'));
        expect(focusedRule).toBeDefined();
        expect(focusedRule!.includes('.cm-scroller')).toBe(true);
        expect(focusedRule!.includes('.cm-selectionLayer')).toBe(true);
    });

    /**
     * An unknown custom property makes the whole declaration invalid rather
     * than falling back to something visible, so a misspelled token reads as
     * "this element was never styled". `color` inherits, which is how a
     * camelCased `--surface-mutedForeground` left the placeholder at full text
     * brightness while looking perfectly correct in the source.
     */
    test('every theme token is kebab-case, as the theme emits them', () => {
        const tokens = [...declarations.matchAll(/var\((--[A-Za-z-]+)/g)].map((m) => m[1]);
        expect(tokens.length > 0).toBe(true);
        expect(tokens.filter((token) => /[A-Z]/.test(token))).toEqual([]);
    });

    test('the selection is translucent so token colours survive it', () => {
        const rules = selectors
            .filter((selector) => selector.includes('.cm-selectionBackground'))
            .map((selector) =>
                (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[selector]);
        expect(rules.length > 0).toBe(true);
        for (const rule of rules) {
            expect(rule.background.includes('transparent')).toBe(true);
        }
    });

    test('the common theme does not re-show the native selection', () => {
        expect(selectors.some((selector) => selector.includes('::selection'))).toBe(false);
    });
});

describe('composerNativeSelectionTheme', () => {
    const nativeSelectors = Object.keys(NATIVE_SELECTION_THEME_SPEC);
    const nativeDeclarations = JSON.stringify(NATIVE_SELECTION_THEME_SPEC);

    /**
     * Every device except iOS layers this over `drawSelection()`: the native
     * selection paints over token backgrounds (the painted layer is hidden
     * behind them) and the platform attaches its selection handles to it.
     * `drawSelection()` must NOT be removed for that: without it CodeMirror
     * starts enforcing cursor association on the native selection while typing
     * in wrapped text, and iOS answers those programmatic selection moves with
     * severe input lag.
     */
    test('it compiles and can be installed', () => {
        expect(installationError(composerNativeSelectionExtension)).toBeNull();
    });

    /**
     * `drawSelection()` hides the native selection through a `Prec.highest`
     * theme with `!important` on `.cm-line ::selection`. Winning that back
     * needs both `!important` and strictly more specificity, because the
     * mount order of two highest-precedence themes is not something to bet
     * on.
     */
    test('the native selection is re-shown with enough weight to win', () => {
        const rule = nativeSelectors.find((selector) => selector.includes('::selection'));
        expect(rule).toBeDefined();
        expect(rule!.includes('.cm-content')).toBe(true);
        expect(rule!.includes('.cm-line')).toBe(true);
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.backgroundColor.includes('!important')).toBe(true);
        expect(value.backgroundColor.includes('transparent')).toBe(true);
    });

    test('the painted selection layer is hidden so highlights do not stack', () => {
        const rule = nativeSelectors.find((selector) => selector.includes('.cm-selectionLayer'));
        expect(rule).toBeDefined();
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.display).toBe('none');
    });

    /**
     * A platform showing native handles colours them from the caret colour.
     * With `drawSelection()`'s `caret-color: transparent !important` in effect
     * the handles are drawn — invisibly. The native caret must come back with
     * enough weight to win, and the drawn cursor layer must go so there are
     * not two carets.
     *
     * BUT a visible native caret makes WebKit re-render its caret UI after
     * every keystroke's decoration redraw — severe input lag. Both rules are
     * therefore scoped to `.oc-native-range`, which only exists while a range
     * is selected (when there is no caret to lag on).
     */
    test('the native caret is re-enabled, since the handles take its colour', () => {
        const rule = nativeSelectors.find((selector) =>
            selector.includes('.cm-content')
            && (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[selector].caretColor);
        expect(rule).toBeDefined();
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.caretColor.startsWith('var(--')).toBe(true);
        expect(value.caretColor.includes('!important')).toBe(true);
        expect(rule!.includes('&.cm-editor')).toBe(true);
    });

    test('the native caret shows only while a range is selected', () => {
        for (const selector of nativeSelectors) {
            const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[selector];
            if (value.caretColor) {
                expect(selector.includes('.oc-native-range')).toBe(true);
            }
        }
    });

    test('the drawn cursor layer is hidden so there are not two carets', () => {
        const rule = nativeSelectors.find((selector) => selector.includes('.cm-cursorLayer'));
        expect(rule).toBeDefined();
        expect(rule!.includes('.oc-native-range')).toBe(true);
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.display).toBe('none');
    });

    test('every theme token is kebab-case, as the theme emits them', () => {
        const tokens = [...nativeDeclarations.matchAll(/var\((--[A-Za-z-]+)/g)].map((m) => m[1]);
        expect(tokens.length > 0).toBe(true);
        expect(tokens.filter((token) => /[A-Z]/.test(token))).toEqual([]);
    });
});

describe('composerIOSSelectionExtension', () => {
    const layerRule = IOS_SELECTION_THEME_SPEC['& .cm-scroller > .cm-selectionLayer'];
    const scrollerRule = IOS_SELECTION_THEME_SPEC['& .cm-scroller'];
    const selectionBackgroundRule = IOS_SELECTION_THEME_SPEC['& .cm-selectionBackground'];

    test('it compiles and can be installed', () => {
        expect(installationError(composerIOSSelectionExtension)).toBeNull();
    });

    /**
     * CodeMirror renders its selection layer at `z-index: -1`, behind the
     * text. Inline code and code fences have opaque backgrounds and otherwise
     * cover both the selection and the iOS handles. The base value is inline,
     * so raising it without `!important` silently does nothing.
     */
    test('CodeMirror selection and handles are raised above token backgrounds', () => {
        expect(layerRule.zIndex).toBe('100 !important');
    });

    /**
     * The layer now sits over the content and would intercept taps and drags
     * by default. It only paints; CodeMirror/WebKit still own the gestures.
     */
    test('the layer does not intercept touch', () => {
        expect(layerRule.pointerEvents).toBe('none');
    });

    /**
     * A higher z-index cannot escape overflow clipping. CodeMirror's dots
     * extend 8px past the range, so the scroller needs that much internal room;
     * the matching negative margin keeps the text and composer height fixed.
     */
    test('the scroller reserves unclipped room for both handles', () => {
        expect(scrollerRule.paddingBlock).toBe('8px');
        expect(scrollerRule.marginBlock).toBe('-8px');
    });

    test('the CodeMirror fill does not stack over the iOS system highlight', () => {
        expect(selectionBackgroundRule.background).toBe('transparent !important');
    });

    /**
     * A second custom layer was visually indistinguishable from duplicate
     * native selection UI. iOS must only reposition the one layer that
     * CodeMirror already uses for both selection rectangles and handles.
     */
    test('it does not add a second selection implementation', () => {
        expect(Object.keys(IOS_SELECTION_THEME_SPEC)).toEqual([
            '& .cm-scroller',
            '& .cm-scroller > .cm-selectionLayer',
            '& .cm-selectionBackground',
        ]);
    });
});

describe('composerSelectionExtension', () => {
    /**
     * The split is the point: iOS is the only platform that pays for a visible
     * native selection during composition, and CodeMirror 6.43.9 draws its
     * handles. Collapsing the two branches into one would
     * either restore the latency on iOS or leave every other platform without
     * discoverable range selection.
     */
    test('the CodeMirror iOS path uses its handles; other platforms keep native selection', () => {
        expect(composerSelectionExtension(true)).toBe(composerIOSSelectionExtension);
        expect(composerSelectionExtension(false)).toBe(composerNativeSelectionExtension);
    });

    /**
     * The composer may remove the native fallback only when CodeMirror's own
     * browser predicate enables its replacement handles. This deliberately
     * includes CodeMirror's vendor and touch thresholds rather than using a
     * broader application-level iOS heuristic.
     */
    test('the platform predicate matches CodeMirror 6.43.9', () => {
        expect(isCodeMirrorIOSNavigator(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6) Mobile/15E148 Safari/604.1',
            'Apple Computer, Inc.',
            5,
        )).toBe(true);
        expect(isCodeMirrorIOSNavigator(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
            'Apple Computer, Inc.',
            5,
        )).toBe(true);
        expect(isCodeMirrorIOSNavigator(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
            'Google Inc.',
            5,
        )).toBe(false);
        expect(isCodeMirrorIOSNavigator(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
            'Apple Computer, Inc.',
            0,
        )).toBe(false);
        expect(isCodeMirrorIOSNavigator(
            'Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0)',
            'Apple Computer, Inc.',
            5,
        )).toBe(false);
    });
});
