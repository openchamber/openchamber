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

const handle = (partId: string, log: string[]): PageFrameHandle => ({
    partId,
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
