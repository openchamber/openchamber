import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

const CARET_PHASE_MS = 600;
const HIDDEN_CLASS = 'oc-caret-hidden';

class CaretBlink {
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly window: Window | null;
    private readonly onWindowFocusChange = () => this.restart();

    constructor(private readonly view: EditorView) {
        this.window = view.dom.ownerDocument.defaultView;
        this.window?.addEventListener('focus', this.onWindowFocusChange);
        this.window?.addEventListener('blur', this.onWindowFocusChange);
        this.restart();
    }

    update(update: ViewUpdate): void {
        if (update.focusChanged || update.selectionSet || update.docChanged) this.restart();
    }

    destroy(): void {
        this.window?.removeEventListener('focus', this.onWindowFocusChange);
        this.window?.removeEventListener('blur', this.onWindowFocusChange);
        this.stop();
    }

    private restart(): void {
        this.stop();
        if (!this.view.hasFocus || !this.view.dom.ownerDocument.hasFocus()) return;
        // external: https://github.com/codemirror/view/blob/main/src/editorview.ts CodeMirror recomputes the editor root class on updates; the scroller preserves the blink class.
        this.timer = setInterval(() => this.view.scrollDOM.classList.toggle(HIDDEN_CLASS), CARET_PHASE_MS);
    }

    private stop(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
        this.view.scrollDOM.classList.remove(HIDDEN_CLASS);
    }
}

export const timerCaretBlink = (): Extension => [
    // external: https://github.com/codemirror/view/blob/main/src/draw-selection.ts CodeMirror uses the smallest configured blink rate, so zero disables the duration across drawSelection instances.
    drawSelection({ cursorBlinkRate: 0 }),
    ViewPlugin.fromClass(CaretBlink),
    EditorView.baseTheme({
        [`.cm-scroller.${HIDDEN_CLASS} > .cm-cursorLayer`]: { opacity: 0 },
        // external: https://github.com/codemirror/view/blob/main/src/draw-selection.ts A zero-duration blink still swaps inline animation names on caret moves; important overrides prevent per-keystroke animation events.
        '.cm-cursorLayer': { animationName: 'none !important' },
    }),
];
