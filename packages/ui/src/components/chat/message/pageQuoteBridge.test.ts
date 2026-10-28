import { describe, expect, test } from 'bun:test';

import {
    clearOtherPageSelections,
    emitPageMarkClick,
    getPageMarks,
    onPageMarkClick,
    registerPageFrame,
    revealPageMark,
    setPageMarks,
    subscribePageMarks,
    type PageFrameHandle,
} from './pageQuoteBridge';

const anchor = { text: 'bold', prefix: 'Use ', suffix: ' text', start: 4 };
const mark = (id: string) => ({ id, anchor, focused: false });

const handle = (partId: string, log: string[], viewId?: string): PageFrameHandle => ({
    partId,
    viewId,
    reveal: () => { log.push(`reveal ${partId}`); },
    clearSelection: () => { log.push(`clear ${partId}`); },
});

describe('page quote bridge', () => {
    test('a reveal goes to the frame registered last for that page, and says whether there was one', () => {
        const log: string[] = [];
        const inline = handle('p1', log);
        const full = { ...handle('p1', log), reveal: () => { log.push('reveal full'); } };
        const unregisterInline = registerPageFrame(inline);
        const unregisterFull = registerPageFrame(full);

        expect(revealPageMark('p1', anchor)).toBe(true);
        expect(log).toEqual(['reveal full']);

        unregisterFull();
        expect(revealPageMark('p1', anchor)).toBe(true);
        expect(log).toEqual(['reveal full', 'reveal p1']);

        unregisterInline();
        expect(revealPageMark('p1', anchor)).toBe(false);
    });

    test('keeps quote routing separate for HtmlViews in the same part', () => {
        const log: string[] = [];
        const first = handle('p1', log, 'first');
        const second = handle('p1', log, 'second');
        const unregister = [first, second].map(registerPageFrame);

        expect(revealPageMark('p1', anchor, 'second')).toBe(true);
        expect(log).toEqual(['reveal p1']);
        expect(revealPageMark('p1', anchor, 'missing')).toBe(false);

        unregister.forEach((remove) => remove());
    });

    test('returns marks only for the HtmlView that owns them', () => {
        const owner = Symbol('column');
        setPageMarks(owner, new Map([['p1', [
            { ...mark('first'), anchor: { ...anchor, page: { partId: 'p1', viewId: 'first' } } },
            { ...mark('second'), anchor: { ...anchor, page: { partId: 'p1', viewId: 'second' } } },
        ]]]));

        expect(getPageMarks('p1', 'first').map((item) => item.id)).toEqual(['first']);
        expect(getPageMarks('p1', 'second').map((item) => item.id)).toEqual(['second']);
        setPageMarks(owner, new Map());
    });

    test('a selection in one page clears every other page\'s, not its own', () => {
        const log: string[] = [];
        const a = handle('a', log);
        const unregister = [a, handle('b', log), handle('c', log)].map(registerPageFrame);

        clearOtherPageSelections(a);

        expect(log.sort()).toEqual(['clear b', 'clear c']);
        unregister.forEach((fn) => fn());
    });

    test('marks are kept per column and page, and listeners hear only their page change', () => {
        const columnA = Symbol('column A');
        const columnB = Symbol('column B');
        const heard: string[] = [];
        const stopP1 = subscribePageMarks('p1', () => heard.push('p1'));
        const stopP2 = subscribePageMarks('p2', () => heard.push('p2'));

        setPageMarks(columnA, new Map([['p1', [mark('m1')]]]));
        setPageMarks(columnB, new Map([['p1', [mark('m2')]], ['p2', [mark('m3')]]]));
        expect(getPageMarks('p1').map((m) => m.id).sort()).toEqual(['m1', 'm2']);
        expect(getPageMarks('p2').map((m) => m.id)).toEqual(['m3']);
        expect(heard).toEqual(['p1', 'p1', 'p2']);

        // A column going away takes only its own marks, and tells the pages it had marked.
        heard.length = 0;
        setPageMarks(columnB, new Map());
        expect(getPageMarks('p1').map((m) => m.id)).toEqual(['m1']);
        expect(getPageMarks('p2')).toEqual([]);
        expect(heard.sort()).toEqual(['p1', 'p2']);

        setPageMarks(columnA, new Map());
        stopP1();
        stopP2();
        expect(getPageMarks('p1')).toEqual([]);
    });

    test('a click on a mark reaches every listener until it unsubscribes', () => {
        const clicks: string[] = [];
        const stop = onPageMarkClick((click) => clicks.push(click.markId));
        const click = { partId: 'p1', markId: 'm1', measure: () => { throw new Error('not measured'); }, portalTarget: null };

        emitPageMarkClick(click);
        stop();
        emitPageMarkClick(click);

        expect(clicks).toEqual(['m1']);
    });
});
