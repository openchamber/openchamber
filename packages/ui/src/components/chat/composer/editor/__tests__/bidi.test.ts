import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
});

const { EditorView } = await import('@codemirror/view');
const { composerBidi } = await import('../bidi');
const views: InstanceType<typeof EditorView>[] = [];

afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.replaceChildren();
});
afterAll(() => dom.happyDOM.close());

function editor(doc: string) {
    const view = new EditorView({ doc, extensions: [composerBidi], parent: document.body });
    views.push(view);
    return view;
}

describe('composer bidi lifecycle', () => {
    test('the root remains fixed while every logical line resolves independently', () => {
        const view = editor('مرحبا\nEnglish.\nשלום\n');
        expect(view.contentDOM.dir).toBe('ltr');
        expect(view.state.facet(EditorView.perLineTextDirection)).toBe(true);
        expect(Array.from(view.contentDOM.querySelectorAll('.cm-line'), (line) => line.getAttribute('dir')))
            .toEqual(['auto', 'auto', 'auto', 'auto']);
    });

    test('splitting and joining lines keeps direction attributes without changing source', () => {
        const view = editor('مرحبا English.');
        view.dispatch({ changes: { from: 5, to: 6, insert: '\n' } });
        expect(view.state.doc.toString()).toBe('مرحبا\nEnglish.');
        expect(view.contentDOM.querySelectorAll('.cm-line[dir="auto"]')).toHaveLength(2);
        view.dispatch({ changes: { from: 5, to: 6, insert: ' ' } });
        expect(view.state.doc.toString()).toBe('مرحبا English.');
        expect(view.contentDOM.querySelectorAll('.cm-line[dir="auto"]')).toHaveLength(1);
        expect(view.contentDOM.dir).toBe('ltr');
    });

    test('direction decoration is bounded to rendered lines in a long document', () => {
        const view = editor(Array.from({ length: 2000 }, (_, index) => `${index} مرحبا`).join('\n'));
        const lines = view.contentDOM.querySelectorAll('.cm-line');
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.length).toBeLessThan(2000);
        expect(Array.from(lines).every((line) => line.getAttribute('dir') === 'auto')).toBe(true);
    });
});
