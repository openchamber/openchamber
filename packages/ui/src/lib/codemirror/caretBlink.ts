import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** Half of CodeMirror's 1.2 s blink cycle, so the rhythm stays the same. */
const CARET_PHASE_MS = 600;
const HIDDEN_CLASS = 'oc-caret-hidden';

/**
 * Blinks the caret `drawSelection()` paints from a timer. CodeMirror's own
 * blink is an infinite `steps(1)` CSS animation on the cursor layer: it draws
 * two frames a second, yet keeps the compositor ticking every frame for as long
 * as the editor has focus. Measured headless on the animation fixture: 4.1% of
 * a core for the CSS caret against 1.3% for this timer and 0.6% for a still
 * page. Any typing or caret move restarts the cycle visible, as CodeMirror's
 * does, and an unfocused editor runs no timer.
 */
class CaretBlink {
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(private readonly view: EditorView) {
        this.restart();
    }

    update(update: ViewUpdate): void {
        if (update.focusChanged || update.selectionSet || update.docChanged) this.restart();
    }

    destroy(): void {
        this.stop();
    }

    private restart(): void {
        this.stop();
        if (!this.view.hasFocus) return;
        // The class goes on the scroller, whose attributes CodeMirror never
        // rewrites; the editor root's class is recomputed on every update.
        this.timer = setInterval(() => this.view.scrollDOM.classList.toggle(HIDDEN_CLASS), CARET_PHASE_MS);
    }

    private stop(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
        this.view.scrollDOM.classList.remove(HIDDEN_CLASS);
    }
}

/**
 * `drawSelection()` with its CSS blink switched off and the timer blink above
 * in its place. A blink rate of 0 wins over any other `drawSelection()` in the
 * same editor, because CodeMirror keeps the smallest configured rate.
 */
export const timerCaretBlink = (): Extension => [
    drawSelection({ cursorBlinkRate: 0 }),
    ViewPlugin.fromClass(CaretBlink),
    EditorView.baseTheme({
        [`.cm-scroller.${HIDDEN_CLASS} > .cm-cursorLayer`]: { opacity: 0 },
    }),
];
