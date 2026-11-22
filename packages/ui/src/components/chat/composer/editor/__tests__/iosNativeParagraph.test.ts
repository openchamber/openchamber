import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// Issue #5746: an iOS keyboard cleaning up dictation inserts native paragraph
// DIVs and keeps writing into them. This drives CodeMirror's real observer and
// document reader with that DOM sequence (from ChangeHow's reproduction in
// #5739), delivering mutations and animation frames by hand. It models the
// event order, not WebKit.
const browser = new Window();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const observers: ManualMutationObserver[] = [];
class ManualMutationObserver extends browser.MutationObserver {
    constructor(private readonly deliver: ConstructorParameters<typeof browser.MutationObserver>[0]) {
        super(deliver);
        observers.push(this);
    }

    deliverRecords() {
        const records = this.takeRecords();
        if (records.length) this.deliver(records, this);
    }
}

const requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
};
const cancelAnimationFrame = (id: number) => { frames.delete(id); };
Object.assign(globalThis, {
    window: browser, Window: browser.Window, document: browser.document,
    navigator: { userAgent: 'Mobile/15E148 Safari/604.1', vendor: 'Apple Computer, Inc.', platform: 'iPhone', maxTouchPoints: 5 },
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    MutationObserver: ManualMutationObserver, ResizeObserver: browser.ResizeObserver,
    requestAnimationFrame, cancelAnimationFrame,
    getComputedStyle: browser.getComputedStyle.bind(browser),
});
Object.assign(browser, { requestAnimationFrame, cancelAnimationFrame });

// CodeMirror reads the browser flags on import, so the iOS navigator goes first.
const { EditorState } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const { ComposerEditorView } = await import('../ComposerEditorView');

function deliverMutations() {
    for (const observer of observers) observer.deliverRecords();
}

function runFrame() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
}

function nativeParagraph(content: HTMLElement) {
    const paragraph = document.createElement('div');
    paragraph.appendChild(document.createElement('br'));
    content.appendChild(paragraph);
    deliverMutations();
    return paragraph;
}

function nativeText(paragraph: HTMLElement, text: string) {
    paragraph.textContent = text;
    deliverMutations();
}

const EXPECTED = 'cleaned first\nsecond\n\nthird and more';

describe('iOS keyboard native paragraphs (#5746)', () => {
    let view: InstanceType<typeof ComposerEditorView>;
    let edits: string[];

    beforeEach(() => {
        edits = [];
        view = new ComposerEditorView({
            parent: document.body,
            state: EditorState.create({
                doc: 'old draft',
                extensions: [EditorView.updateListener.of((update) => {
                    if (update.docChanged) edits.push(update.state.doc.toString());
                })],
            }),
        });
        // The keyboard deletes its first transcript, then writes the cleaned one.
        view.contentDOM.firstChild!.textContent = '';
        deliverMutations();
        view.contentDOM.firstChild!.textContent = 'cleaned first';
        deliverMutations();
        edits.length = 0;
    });

    afterEach(() => { view.destroy(); frames.clear(); });

    // Writes the rest of the cleaned text into the keyboard's own paragraphs.
    async function writeParagraphs(between?: () => void) {
        const second = nativeParagraph(view.contentDOM);
        nativeText(second, 'second');
        if (between) {
            between();
            // Keyboard writes arrive in later tasks, after pending microtasks.
            await Promise.resolve();
        }
        nativeParagraph(view.contentDOM);
        const third = nativeParagraph(view.contentDOM);
        nativeText(third, 'third');
        nativeText(third, 'third and more');
    }

    test('keeps every batch the keyboard writes into its new paragraphs', async () => {
        await writeParagraphs();
        runFrame();
        deliverMutations();

        expect(view.state.doc.toString()).toBe(EXPECTED);
        expect(edits).toEqual([EXPECTED]);
        runFrame();
        deliverMutations();
        expect(view.state.doc.toString()).toBe(EXPECTED);
        expect(edits).toHaveLength(1);
    });

    test('keeps a pending paragraph when another update runs before the frame', async () => {
        // Like the focus-change transaction a focus timer dispatches.
        await writeParagraphs(() => view.dispatch({}));
        runFrame();
        deliverMutations();

        expect(view.state.doc.toString()).toBe(EXPECTED);
    });

    test('keeps a pending paragraph when the editor is focused before the frame', () => {
        const second = nativeParagraph(view.contentDOM);
        nativeText(second, 'second');
        view.focus();
        runFrame();
        deliverMutations();

        expect(view.state.doc.toString()).toBe('cleaned first\nsecond');
    });

    test('keeps a pending paragraph when the layout is read before the frame', () => {
        const second = nativeParagraph(view.contentDOM);
        nativeText(second, 'second');
        view.requestMeasure();
        view.coordsAtPos(0);
        runFrame();
        deliverMutations();

        expect(view.state.doc.toString()).toBe('cleaned first\nsecond');
    });
});
