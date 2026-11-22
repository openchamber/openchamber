import { CharCategory, EditorSelection, findClusterBreak, Prec, type EditorState, type Extension, type SelectionRange } from '@codemirror/state';
import { Direction, EditorView, keymap, type ViewUpdate } from '@codemirror/view';

type SplitScript = 'han' | 'latin' | null;

function splitScriptOf(char: string): SplitScript {
    if (/\p{Script=Han}/u.test(char)) return 'han';
    if (/\p{Script=Latin}/u.test(char)) return 'latin';
    return null;
}

function isHanLatinBoundary(text: string, at: number, categorize: (char: string) => CharCategory): boolean {
    if (at <= 0 || at >= text.length) return false;
    const after = text.slice(at, findClusterBreak(text, at));
    const script = splitScriptOf(after);
    if (!script || categorize(after) !== CharCategory.Word) return false;
    for (let pos = at; pos > 0;) {
        const prev = findClusterBreak(text, pos, false);
        const char = text.slice(prev, pos);
        if (categorize(char) !== CharCategory.Word) return false;
        const before = splitScriptOf(char);
        if (before) return before !== script;
        pos = prev;
    }
    return false;
}

function firstHanLatinBoundaryBetween(state: EditorState, head: number, target: number): number {
    if (head === target) return target;
    const forward = target > head;
    const lo = Math.min(head, target);
    const hi = Math.max(head, target);
    const categorize = state.charCategorizer(head);
    let found = target;
    for (let line = state.doc.lineAt(lo); ; line = state.doc.line(line.number + 1)) {
        for (let at = Math.max(lo, line.from) - line.from; at < line.text.length; at = findClusterBreak(line.text, at)) {
            const pos = at + line.from;
            if (pos >= hi) break;
            if (pos > lo && isHanLatinBoundary(line.text, at, categorize)) {
                if (forward) return pos;
                found = pos;
            }
        }
        if (line.to >= hi) return found;
    }
}

function stockGroup(categorize: (char: string) => CharCategory, start: string): (next: string) => boolean {
    let category = categorize(start);
    return (next) => {
        const nextCategory = categorize(next);
        if (category === CharCategory.Space) category = nextCategory;
        return nextCategory === category;
    };
}

export function wordRangeAt(
    state: EditorState,
    pos: number,
    bias: -1 | 1 = 1,
): { from: number; to: number } | null {
    const line = state.doc.lineAt(pos);
    const text = line.text;
    if (text.length === 0) return null;

    const linePos = pos - line.from;
    if (linePos === 0) bias = 1;
    else if (linePos === text.length) bias = -1;

    let from = linePos;
    let to = linePos;
    if (bias < 0) from = findClusterBreak(text, linePos, false);
    else to = findClusterBreak(text, linePos);

    const categorize = state.charCategorizer(pos);
    const clicked = text.slice(from, to);
    const category = categorize(clicked);
    const clickedFrom = from + line.from;
    const clickedTo = to + line.from;
    const joins = (char: string) => categorize(char) === category;
    while (from > 0) {
        const prev = findClusterBreak(text, from, false);
        if (!joins(text.slice(prev, from))) break;
        from = prev;
    }
    while (to < text.length) {
        const next = findClusterBreak(text, to);
        if (!joins(text.slice(to, next))) break;
        to = next;
    }
    return {
        from: firstHanLatinBoundaryBetween(state, clickedTo, from + line.from),
        to: firstHanLatinBoundaryBetween(state, clickedFrom, to + line.from),
    };
}

function scriptAwareMouseSelection(
    view: EditorView,
    event: MouseEvent,
): {
    get: (event: MouseEvent, extend: boolean, multiple: boolean) => EditorSelection;
    update: (update: ViewUpdate) => void;
} | null {
    if (event.detail !== 2) return null;

    const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
    let startSel = view.state.selection;

    return {
        update(update) {
            if (!update.docChanged) return;
            start.pos = update.changes.mapPos(start.pos);
            startSel = startSel.map(update.changes);
        },
        get(event, extend, multiple) {
            const cur = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
            const clicked = wordRangeAt(view.state, cur.pos, cur.assoc);
            let range = clicked
                ? EditorSelection.undirectionalRange(clicked.from, clicked.to)
                : EditorSelection.cursor(cur.pos, cur.assoc);

            if ((start.pos !== cur.pos || start.assoc !== cur.assoc) && !extend) {
                const startRange = wordRangeAt(view.state, start.pos, start.assoc);
                const startRangeSel = startRange
                    ? EditorSelection.undirectionalRange(startRange.from, startRange.to)
                    : EditorSelection.cursor(start.pos, start.assoc);
                const from = Math.min(startRangeSel.from, range.from);
                const to = Math.max(startRangeSel.to, range.to);
                range = from < range.from
                    ? EditorSelection.range(from, to, range.assoc)
                    : EditorSelection.range(to, from, range.assoc);
            }

            if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
            if (multiple) return startSel.addRange(range);
            return EditorSelection.create([range]);
        },
    };
}

const moveByWordGroup = (
    view: EditorView,
    range: SelectionRange,
    forward: boolean,
): SelectionRange => {
    const categorize = view.state.charCategorizer(range.head);
    const moved = view.moveByChar(range, forward, (start) => stockGroup(categorize, start));
    const stop = firstHanLatinBoundaryBetween(view.state, range.head, moved.head);
    return stop === moved.head ? moved : EditorSelection.cursor(stop, stop > range.head ? -1 : 1);
};

function updateSelection(
    selection: EditorSelection,
    by: (range: SelectionRange) => SelectionRange,
): EditorSelection {
    return EditorSelection.create(selection.ranges.map(by), selection.mainIndex);
}

const ltrAtCursor = (view: EditorView): boolean =>
    view.textDirectionAt(view.state.selection.main.head) === Direction.LTR;

function cursorByWordGroup(view: EditorView, forward: boolean): boolean {
    const selection = updateSelection(view.state.selection, (range) => (range.empty
        ? moveByWordGroup(view, range, forward)
        : EditorSelection.cursor(forward ? range.to : range.from)));
    if (selection.eq(view.state.selection, true)) return false;
    view.dispatch(view.state.update({ selection, scrollIntoView: true, userEvent: 'select' }));
    return true;
}

function selectByWordGroup(view: EditorView, forward: boolean): boolean {
    const selection = updateSelection(view.state.selection, (range) => {
        const oriented = range.undirectional && (range.head >= range.anchor) !== forward
            ? EditorSelection.range(range.head, range.anchor)
            : range;
        const head = moveByWordGroup(view, oriented, forward);
        return EditorSelection.range(
            oriented.anchor,
            head.head,
            head.goalColumn,
            head.bidiLevel || undefined,
            head.assoc,
        );
    });
    if (selection.eq(view.state.selection)) return false;
    view.dispatch(view.state.update({ selection, scrollIntoView: true, userEvent: 'select' }));
    return true;
}

function cursorWordGroupLeft(view: EditorView): boolean {
    return cursorByWordGroup(view, !ltrAtCursor(view));
}

function cursorWordGroupRight(view: EditorView): boolean {
    return cursorByWordGroup(view, ltrAtCursor(view));
}

function selectWordGroupLeft(view: EditorView): boolean {
    return selectByWordGroup(view, !ltrAtCursor(view));
}

function selectWordGroupRight(view: EditorView): boolean {
    return selectByWordGroup(view, ltrAtCursor(view));
}

function deleteStop(state: EditorState, head: number, forward: boolean): number {
    const line = state.doc.lineAt(head);
    const categorize = state.charCategorizer(head);
    let pos = head;
    let category: CharCategory | null = null;

    for (;;) {
        if (pos === (forward ? line.to : line.from)) {
            if (pos === head && line.number !== (forward ? state.doc.lines : 1)) {
                pos += forward ? 1 : -1;
            }
            break;
        }

        const next = findClusterBreak(line.text, pos - line.from, forward) + line.from;
        const char = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from);
        const nextCategory = categorize(char);
        if (category !== null && nextCategory !== category) break;
        if (char !== ' ' || pos !== head) category = nextCategory;
        pos = next;
    }

    return firstHanLatinBoundaryBetween(state, head, pos);
}

function skipAtoms(view: EditorView, pos: number, forward: boolean): number {
    let next = pos;
    for (const ranges of view.state.facet(EditorView.atomicRanges).map((range) => range(view))) {
        ranges.between(pos, pos, (from, to) => {
            if (from < pos && to > pos) next = forward ? to : from;
        });
    }
    return next;
}

function deleteWordGroup(view: EditorView, forward: boolean): boolean {
    if (view.state.readOnly) return false;

    let event = 'delete.selection';
    const changes = view.state.changeByRange((range) => {
        let from = range.from;
        let to = range.to;

        if (from === to) {
            let stop = deleteStop(view.state, range.head, forward);
            if (stop < from) {
                event = 'delete.backward';
                stop = skipAtoms(view, stop, false);
            } else if (stop > from) {
                event = 'delete.forward';
                stop = skipAtoms(view, stop, true);
            }
            from = Math.min(from, stop);
            to = Math.max(to, stop);
        } else {
            from = skipAtoms(view, from, false);
            to = skipAtoms(view, to, true);
        }

        return from === to
            ? { range }
            : { changes: { from, to }, range: EditorSelection.cursor(from, from < range.head ? -1 : 1) };
    });

    if (changes.changes.empty) return false;

    view.dispatch(view.state.update(changes, {
        scrollIntoView: true,
        userEvent: event,
        effects: event === 'delete.selection'
            ? EditorView.announce.of(view.state.phrase('Selection deleted'))
            : undefined,
    }));
    return true;
}

function deleteWordGroupBackward(view: EditorView): boolean {
    return deleteWordGroup(view, false);
}

function deleteWordGroupForward(view: EditorView): boolean {
    return deleteWordGroup(view, true);
}

export const scriptAwareWordGestures: Extension = [
    EditorView.mouseSelectionStyle.of(scriptAwareMouseSelection),
    Prec.high(keymap.of([
        {
            key: 'Mod-ArrowLeft',
            mac: 'Alt-ArrowLeft',
            run: cursorWordGroupLeft,
            shift: selectWordGroupLeft,
            preventDefault: true,
        },
        {
            key: 'Mod-ArrowRight',
            mac: 'Alt-ArrowRight',
            run: cursorWordGroupRight,
            shift: selectWordGroupRight,
            preventDefault: true,
        },
        {
            key: 'Mod-Backspace',
            mac: 'Alt-Backspace',
            run: deleteWordGroupBackward,
            preventDefault: true,
        },
        { mac: 'Ctrl-Alt-h', run: deleteWordGroupBackward, preventDefault: true },
        {
            key: 'Mod-Delete',
            mac: 'Alt-Delete',
            run: deleteWordGroupForward,
            preventDefault: true,
        },
    ])),
];
