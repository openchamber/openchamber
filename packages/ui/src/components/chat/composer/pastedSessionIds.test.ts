import { describe, expect, test } from 'bun:test';
import { ChangeSet, Text } from '@codemirror/state';

import { PastedSessionIds, sessionLinkOverPastedId, type PastedSessionIdRange } from './pastedSessionIds';

const ID = 'ses_abc';
const LINK = `openchamber://session/${ID}`;

const edit = (doc: string, from: number, to: number, insert: string) => {
    const changes = ChangeSet.of({ from, to, insert: Text.of(insert.split('\n')) }, doc.length);
    return { value: changes.apply(Text.of(doc.split('\n'))).toString(), changes };
};

const paste = (ids: PastedSessionIds, doc: string, at: number, text: string) => {
    ids.expect(ID);
    const change = edit(doc, at, at, text);
    return { value: change.value, range: ids.applyChange({ ...change, fromPaste: true, fromValueProp: false }) };
};

const follow = (ids: PastedSessionIds, doc: string, from: number, to: number, insert: string) => {
    const change = edit(doc, from, to, insert);
    ids.applyChange({ ...change, fromPaste: false, fromValueProp: false });
    return change.value;
};

const replaceWithLink = (value: string, range: PastedSessionIdRange | null, caret: number) => {
    if (!range) throw new Error('expected the paste to land');
    return sessionLinkOverPastedId(value, range, { start: caret, end: caret }, []);
};

describe('pasted session ids', () => {
    test('finds the id inside the pasted whitespace', () => {
        const { range } = paste(new PastedSessionIds(), 'see ', 4, `  ${ID}\n`);
        expect(range).toMatchObject({ sessionId: ID, from: 6, to: 6 + ID.length });
    });

    test('follows text added before the id while the session is read', () => {
        const ids = new PastedSessionIds();
        const { value, range } = paste(ids, 'see ', 4, ID);
        const edited = follow(ids, value, 0, 0, 'please ');
        const caret = edited.length;
        const result = replaceWithLink(edited, range, caret);
        expect(result?.link).toBe(LINK);
        expect(result?.selection.start).toBe(caret + LINK.length - ID.length);
        expect(`${edited.slice(0, range?.from)}${result?.link}${edited.slice(range?.to)}`).toBe(`please see ${LINK}`);
    });

    test('keeps a caret that moved before the id where it is', () => {
        const { value, range } = paste(new PastedSessionIds(), 'see ', 4, ID);
        expect(replaceWithLink(value, range, 2)?.selection).toEqual({ start: 2, end: 2 });
    });

    test('leaves an id the user changed as text', () => {
        const ids = new PastedSessionIds();
        const { value, range } = paste(ids, '', 0, ID);
        expect(replaceWithLink(follow(ids, value, 5, 5, 'x'), range, 0)).toBeNull();
    });

    test('leaves an id the user deleted', () => {
        const ids = new PastedSessionIds();
        const { value, range } = paste(ids, '', 0, ID);
        expect(replaceWithLink(follow(ids, value, 0, value.length, ''), range, 0)).toBeNull();
    });

    test('leaves an id that now runs into a typed word as text', () => {
        const ids = new PastedSessionIds();
        const { value, range } = paste(ids, '', 0, ID);
        expect(replaceWithLink(follow(ids, value, value.length, value.length, 'x'), range, 0)).toBeNull();
    });

    test('leaves an id pasted into an address alone', () => {
        const doc = 'openchamber://session/';
        const { value, range } = paste(new PastedSessionIds(), doc, doc.length, ID);
        expect(replaceWithLink(value, range, 0)).toBeNull();
    });

    test('forgets every id when the app sets other text', () => {
        const ids = new PastedSessionIds();
        const { value, range } = paste(ids, '', 0, ID);
        ids.applyChange({ ...edit(value, 0, value.length, 'another draft'), fromPaste: false, fromValueProp: true });
        expect(range && ids.settle(range)).toBe(false);
    });

    test('an expected id does not outlive the edit after it', () => {
        const ids = new PastedSessionIds();
        ids.expect(ID);
        expect(ids.applyChange({ ...edit('', 0, 0, ID), fromPaste: false, fromValueProp: false })).toBeNull();
        expect(ids.applyChange({ ...edit(ID, 0, 0, ID), fromPaste: true, fromValueProp: false })).toBeNull();
    });
});
