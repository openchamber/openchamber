import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

const CLEANUP_WINDOW_MS = 400;

/** Sogou's Send-key long press can leave padding in the DOM only. */
export function imeNewlineCleanup(): Extension {
    let insertion: { from: number; at: number; committed: boolean; padding: boolean } | null = null;

    const current = (view: EditorView) => {
        const selection = view.state.selection;
        if (!insertion || Date.now() - insertion.at > CLEANUP_WINDOW_MS
            || selection.ranges.length !== 1 || !selection.main.empty
            || selection.main.head !== insertion.from + (insertion.committed ? 1 : 0)) {
            insertion = null;
        }
        return insertion;
    };

    const observePadding = (view: EditorView) => {
        const mark = current(view);
        if (!mark?.committed) return;
        const head = view.state.selection.main.head;
        const { node } = view.domAtPos(head);
        const element = node instanceof Element ? node : node.parentElement;
        const line = element?.closest('.cm-line');
        const selection = view.contentDOM.ownerDocument.getSelection();
        if (!line || !selection?.isCollapsed || !selection.anchorNode || !line.contains(selection.anchorNode)) return;
        const beforeCaret = view.contentDOM.ownerDocument.createRange();
        beforeCaret.selectNodeContents(line);
        beforeCaret.setEnd(selection.anchorNode, selection.anchorOffset);
        if (line.textContent === ` ${view.state.doc.lineAt(head).text}` && beforeCaret.toString() === ' ') {
            mark.padding = true;
        }
    };

    const consumeCleanup = (view: EditorView) => {
        const mark = current(view);
        const consume = mark?.committed === true && mark.padding;
        insertion = null;
        return consume;
    };

    return [
        EditorView.domEventObservers({
            beforeinput: (event, view) => {
                if (event.inputType === 'insertParagraph'
                    || (event.inputType === 'insertText' && event.data === '\n')) {
                    insertion = view.state.selection.main.empty
                        ? { from: view.state.selection.main.head, at: Date.now(), committed: false, padding: false }
                        : null;
                } else if (event.inputType === 'deleteContentBackward') {
                    observePadding(view);
                } else if (event.inputType !== 'insertText' || event.data !== ' ') {
                    insertion = null;
                }
            },
            input: (_event, view) => { observePadding(view); },
            keydown: (event, view) => {
                if (event.key === 'Backspace') observePadding(view);
                else insertion = null;
            },
            pointerdown: () => { insertion = null; },
            blur: () => { insertion = null; },
        }),
        EditorView.updateListener.of((update) => {
            if (!insertion) return;
            if (update.docChanged) {
                const mark = insertion;
                let newlineOnly = false;
                let count = 0;
                update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
                    count++;
                    newlineOnly = from === mark.from && to === from && inserted.toString() === '\n';
                });
                if (!mark.committed && count === 1 && newlineOnly
                    && update.transactions.some((transaction) => transaction.isUserEvent('input'))) {
                    mark.committed = true;
                    current(update.view);
                } else {
                    insertion = null;
                }
            } else if (update.selectionSet) {
                insertion = null;
            }
        }),
        Prec.highest(keymap.of([
            { key: 'Enter', run: () => { insertion = null; return false; } },
            { key: 'Backspace', run: consumeCleanup },
        ])),
        EditorView.inputHandler.of((view, from, to, text) => {
            const mark = current(view);
            if (mark && !mark.committed && from === mark.from && to === from && text === '\n') return false;
            if (mark?.committed && from === mark.from && to === from + 1 && text === '') {
                return consumeCleanup(view);
            }
            insertion = null;
            return false;
        }),
    ];
}
