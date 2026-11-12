import { afterEach, describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { LargeTextPasteGesture } from '../largeTextPaste';
import { replaceWithCaret } from '../editor/documentEdits';

const gestures: LargeTextPasteGesture[] = [];
afterEach(() => { for (const gesture of gestures.splice(0)) gesture.invalidate(); });

function setup(text = 'x'.repeat(2000), doc = 'before selected after', from = 7, to = 15) {
    const gesture = new LargeTextPasteGesture();
    gestures.push(gesture);
    let state = EditorState.create({ doc, selection: { anchor: from, head: to } });
    let scope = 'runtime/directory/session';
    const read = () => ({ value: state.doc.toString(), selection: { start: state.selection.main.from, end: state.selection.main.to }, scope });
    const key = (repeat = false, metaKey = false, keyValue = 'v', code = 'KeyV') => gesture.keyDown({ key: keyValue, code, ctrlKey: !metaKey, metaKey, altKey: false, shiftKey: false, repeat });
    const paste = (now: number, clipboard = text) => {
        const candidate = gesture.beginPaste(clipboard, read(), now);
        if (!candidate) {
            const selection = state.selection.main;
            const transaction = state.update({ ...replaceWithCaret(state, selection.from, selection.to, clipboard), userEvent: 'input.paste' });
            let insertedText = '';
            transaction.changes.iterChanges((_a, _b, _c, _d, inserted) => { insertedText += inserted.toString(); });
            state = transaction.state;
            gesture.change({ ...read(), fromPaste: true, insertedText });
        }
        gesture.keyUp({ key: 'v', code: 'KeyV', altKey: false });
        return candidate;
    };
    const replace = (start: number, end: number, citation: string) => {
        state = state.update(replaceWithCaret(state, start, end, citation)).state;
        gesture.change({ ...read(), fromPaste: false, insertedText: citation });
    };
    return { gesture, key, paste, read, replace, scope: (next: string) => { scope = next; }, edit: () => {
        state = state.update(replaceWithCaret(state, state.doc.length, state.doc.length, '!')).state;
        gesture.change({ ...read(), fromPaste: false, insertedText: '!' });
    } };
}

describe('large text double-paste gesture with real CodeMirror edits', () => {
    for (const metaKey of [false, true]) test(`${metaKey ? 'Cmd' : 'Ctrl'}+V converts with a Cyrillic key value`, async () => {
        const h = setup();
        h.key(false, metaKey, 'м'); h.paste(100);
        h.key(false, metaKey, 'м'); const candidate = h.paste(200);
        if (!candidate) throw new Error('Expected non-Latin paste conversion');
        expect(await h.gesture.convert(candidate, async () => true, h.read, h.replace, '[file]')).toBe(true);
        expect(h.read().value).toBe('before [file] after');
    });

    test('Latin layouts keep the character-based meaning when V moves to another physical key', () => {
        const h = setup();
        h.key(false, false, 'v', 'Period'); h.paste(100);
        h.key(false, false, 'v', 'Period'); expect(h.paste(200)).not.toBeNull();
    });

    test('a physical V key producing another Latin character does not arm conversion', () => {
        const h = setup();
        h.key(false, false, 'k', 'KeyV'); h.paste(100);
        h.key(false, false, 'k', 'KeyV'); expect(h.paste(200)).toBeNull();
    });

    test('a Cyrillic key release without a delivered paste cannot authorize a later menu paste', () => {
        const h = setup(); h.key(); h.paste(100);
        h.key(false, false, 'м');
        h.gesture.keyUp({ key: 'м', code: 'KeyV', altKey: false });
        expect(h.paste(200)).toBeNull();
    });

    test('first paste inserts immediately; second replaces only its measured CRLF range after acceptance', async () => {
        const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\r\n');
        const h = setup(text);
        h.key(false, true);
        expect(h.paste(100)).toBeNull();
        const inline = `before ${text.replaceAll('\r\n', '\n')} after`;
        expect(h.read().value).toBe(inline);
        h.key(false, true);
        const candidate = h.paste(1099);
        expect(candidate).not.toBeNull();
        if (!candidate) throw new Error('Expected conversion');
        let accept: (success: boolean) => void = () => { throw new Error('Attachment not started'); };
        const pending = h.gesture.convert(candidate, () => new Promise<boolean>((resolve) => { accept = resolve; }), h.read, h.replace, '[file.txt]');
        expect(h.read().value).toBe(inline);
        accept(true);
        expect(await pending).toBe(true);
        expect(h.read().value).toBe('before [file.txt] after');
        expect(h.read().selection.start).toBe(17);
    });

    for (const elapsed of [1000, 1001]) test(`does not convert at ${elapsed}ms`, () => {
        const h = setup(); h.key(); h.paste(100); h.key();
        expect(h.paste(100 + elapsed)).toBeNull();
        expect(h.read().value.match(/x/g)?.length).toBe(4000);
    });

    test('different clipboard text stays inline', () => {
        const h = setup(); h.key(); h.paste(100); h.key();
        expect(h.paste(200, 'y'.repeat(2000))).toBeNull();
        expect(h.read().value).toContain('x'.repeat(2000) + 'y'.repeat(2000));
    });

    test('a moved selection cannot convert even without an invalidation callback', () => {
        const h = setup(); h.key(); h.paste(100); h.key();
        expect(h.gesture.beginPaste('x'.repeat(2000), { ...h.read(), selection: { start: 0, end: 0 } }, 200)).toBeNull();
    });

    test('stale document snapshot cannot authorize destructive replacement', async () => {
        const h = setup(); h.key(); h.paste(100); h.key(); const candidate = h.paste(200);
        if (!candidate) throw new Error('Expected conversion');
        const retained = h.read().value;
        expect(await h.gesture.convert(candidate, async () => true, () => ({ ...h.read(), value: 'newer draft' }),
            () => { throw new Error('Must not replace newer content'); }, '[file]')).toBe(false);
        expect(h.read().value).toBe(retained);
    });

    test('releasing V without a paste cannot authorize a later menu paste', () => {
        const h = setup(); h.key(); h.paste(100); h.key(); h.gesture.keyUp({ key: 'v', code: 'KeyV', altKey: false });
        expect(h.paste(200)).toBeNull();
    });

    test('key repeat cannot convert or arm the next paste', () => {
        const h = setup(); h.key(); h.paste(100); h.key(true); expect(h.paste(200)).toBeNull();
        h.key(); expect(h.paste(300)).toBeNull();
    });

    test('context-menu and touch pastes never convert or arm a candidate', () => {
        const h = setup(); h.paste(100); h.key(); expect(h.paste(200)).toBeNull();
        expect(h.paste(300)).toBeNull();
    });

    for (const reason of ['edit', 'selection', 'blur', 'scope', 'mode', 'unmount']) test(`${reason} invalidates conversion`, () => {
        const h = setup(); h.key(); h.paste(100);
        if (reason === 'edit') h.edit();
        else if (reason === 'scope') h.scope('another/runtime/draft');
        else h.gesture.invalidate();
        h.key(); expect(h.paste(200)).toBeNull();
    });

    test('non-paste keyboard movement invalidates even when caret returns', () => {
        const h = setup(); h.key(); h.paste(100);
        h.gesture.keyDown({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false });
        h.key(); expect(h.paste(200)).toBeNull();
    });

    for (const fails of ['reject', 'throw']) test(`attachment ${fails} retains inline text`, async () => {
        const h = setup(); h.key(); h.paste(100); const inline = h.read().value; h.key(); const candidate = h.paste(200);
        if (!candidate) throw new Error('Expected conversion');
        const run = h.gesture.convert(candidate, async () => { if (fails === 'throw') throw new Error('Rejected'); return false; }, h.read, h.replace, '[file]');
        if (fails === 'throw') await expect(run).rejects.toThrow('Rejected');
        else expect(await run).toBe(false);
        expect(h.read().value).toBe(inline);
    });

    for (const mutation of ['edit', 'scope', 'blur']) test(`async success after ${mutation} never replaces newer text or draft`, async () => {
        const h = setup(); h.key(); h.paste(100); h.key(); const candidate = h.paste(200);
        if (!candidate) throw new Error('Expected conversion');
        let accept: (value: boolean) => void = () => {};
        const run = h.gesture.convert(candidate, () => new Promise<boolean>((resolve) => { accept = resolve; }), h.read, h.replace, '[file]');
        if (mutation === 'edit') h.edit();
        else if (mutation === 'scope') h.scope('new-draft');
        else h.gesture.invalidate();
        const retained = h.read().value; accept(true);
        expect(await run).toBe(false); expect(h.read().value).toBe(retained);
    });

    test('a 100K character insertion can be converted once', async () => {
        const h = setup('x'.repeat(100_000)); h.key(); h.paste(100); h.key(); const candidate = h.paste(200);
        if (!candidate) throw new Error('Expected conversion');
        expect(await h.gesture.convert(candidate, async () => true, h.read, h.replace, '[file]')).toBe(true);
        expect(await h.gesture.convert(candidate, async () => { throw new Error('Duplicate attach'); }, h.read, h.replace, '[file]')).toBe(false);
    });

    test('short text and whitespace do not arm conversion', () => {
        for (const text of ['short', ' '.repeat(2000)]) {
            const h = setup(text); h.key(); h.paste(100); h.key(); expect(h.paste(200)).toBeNull();
        }
    });

    test('candidate expires and releases the clipboard after 1000ms', async () => {
        const h = setup(); h.key(); h.paste(performance.now());
        await new Promise((resolve) => setTimeout(resolve, 1010)); h.key(); expect(h.paste(performance.now())).toBeNull();
    });
});
