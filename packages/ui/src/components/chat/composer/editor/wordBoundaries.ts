import { EditorSelection, findClusterBreak, type EditorState, type SelectionRange } from '@codemirror/state';
import { Direction, EditorView, type ViewUpdate } from '@codemirror/view';

/**
 * Classifies one grapheme cluster so every word gesture stops at script
 * boundaries.
 *
 * CodeMirror's default classifier treats every `\p{Alphabetic}` code point as
 * one "word" class, so Latin and CJK merge and a double-click or Ctrl+Backspace
 * on "检查openchamber的配置" takes the whole run. Distinct classes per script
 * end a word where the script changes. Latin is matched by script rather than
 * an ASCII range, so `café`, `über` and `Straße` stay whole; clusters also
 * carry their combining marks, so a decomposed accent follows its base letter.
 * Classes are only compared for equality, so the numbers are arbitrary.
 */
function wordClass(char: string): number {
    if (/\s/.test(char)) return 0;
    if (/\p{Script=Han}/u.test(char)) return 1;
    if (/[\p{Script=Latin}\p{N}_]/u.test(char)) return 2;
    if (/[\p{L}\p{N}]/u.test(char)) return 3;
    return 4;
}

/**
 * The maximal run of same-class characters around `pos`, mirroring
 * CodeMirror's double-click grouping but split at script boundaries. Returns
 * document positions, or null when the line is empty.
 */
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

    const cls = wordClass(text.slice(from, to));
    while (from > 0) {
        const prev = findClusterBreak(text, from, false);
        if (wordClass(text.slice(prev, from)) !== cls) break;
        from = prev;
    }
    while (to < text.length) {
        const next = findClusterBreak(text, to);
        if (wordClass(text.slice(to, next)) !== cls) break;
        to = next;
    }
    return { from: from + line.from, to: to + line.from };
}

/**
 * A `mouseSelectionStyle` that overrides only double-click word selection.
 * Single and triple clicks fall through to CodeMirror's default handling.
 */
export function scriptAwareMouseSelection(
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

            if (start.pos !== cur.pos && !extend) {
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

/** The walk CodeMirror's `moveByGroup` uses, with the script classes above. */
function groupWalk(start: string): (next: string) => boolean {
    const cls = wordClass(start);
    let initial = cls !== 0;
    return (next) => {
        const nextCls = wordClass(next);
        if (nextCls !== 0) return initial && nextCls === cls;
        initial = false;
        return true;
    };
}

const moveByWordGroup = (
    view: EditorView,
    range: SelectionRange,
    forward: boolean,
): SelectionRange => view.moveByChar(range, forward, (start) => groupWalk(start));

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
        // A backward selection turns around before it grows, so Shift+Arrow
        // after a Shift+Arrow in the other direction shrinks it first.
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

/** Ctrl+Left (Alt+Left on macOS): previous word, split at script boundaries. */
export function cursorWordGroupLeft(view: EditorView): boolean {
    return cursorByWordGroup(view, !ltrAtCursor(view));
}

/** Ctrl+Right (Alt+Right on macOS): next word, split at script boundaries. */
export function cursorWordGroupRight(view: EditorView): boolean {
    return cursorByWordGroup(view, ltrAtCursor(view));
}

/** Ctrl+Shift+Left: grow the selection one script-aware word backward. */
export function selectWordGroupLeft(view: EditorView): boolean {
    return selectByWordGroup(view, !ltrAtCursor(view));
}

/** Ctrl+Shift+Right: grow the selection one script-aware word forward. */
export function selectWordGroupRight(view: EditorView): boolean {
    return selectByWordGroup(view, ltrAtCursor(view));
}

/**
 * Where a word-group delete stops, mirroring `deleteByGroup` in
 * `@codemirror/commands`: it walks inside the line, keeps a single space typed
 * at the caret with the word before it, and joins lines only when the caret
 * already sits at the edge. The difference is the classifier above.
 */
function deleteStop(state: EditorState, head: number, forward: boolean): number {
    const line = state.doc.lineAt(head);
    let pos = head;
    let category: number | null = null;

    for (;;) {
        if (pos === (forward ? line.to : line.from)) {
            if (pos === head && line.number !== (forward ? state.doc.lines : 1)) {
                pos += forward ? 1 : -1;
            }
            break;
        }

        const next = findClusterBreak(line.text, pos - line.from, forward) + line.from;
        const char = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from);
        const nextCategory = wordClass(char);
        if (category !== null && nextCategory !== category) break;
        if (char !== ' ' || pos !== head) category = nextCategory;
        pos = next;
    }

    return pos;
}

/** Chips (mentions, skills, snippets) are atomic; a delete must take them whole. */
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

/** Ctrl+Backspace: delete to the start of the word, split at script boundaries. */
export function deleteWordGroupBackward(view: EditorView): boolean {
    return deleteWordGroup(view, false);
}

/** Ctrl+Delete: delete to the end of the word, split at script boundaries. */
export function deleteWordGroupForward(view: EditorView): boolean {
    return deleteWordGroup(view, true);
}
