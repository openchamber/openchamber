import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

import { MetaRow } from './ReferenceMetaEditors';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
    SVGElement: browser.SVGElement, sessionStorage: browser.sessionStorage,
    Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

const render = async (node: ReactNode) => {
    await act(async () => root.render(node));
};

describe('the metadata list', () => {
    // The preview's rows carry content of different heights — an avatar, a row
    // of label chips, plain text — so each one is its own grid row and takes
    // one row height, instead of the grid sizing rows off whatever each value
    // happens to be.
    test('gives every label and value its own row, so the rows keep one height', async () => {
        await render(
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
                <MetaRow label="Author"><span className="inline-flex items-center gap-1.5"><img alt="" className="size-4" />octocat</span></MetaRow>
                <MetaRow label="Updated">3min ago</MetaRow>
                <MetaRow label="Labels"><span className="inline-flex gap-1"><span>bug</span><span>area</span></span></MetaRow>
            </dl>,
        );

        const list = host.querySelector('dl');
        expect(list).not.toBeNull();
        // Nothing escapes a row: a stray child pair would be laid out as its own
        // two cells and break the shared row height.
        expect(list?.querySelectorAll(':scope > dt').length).toBe(0);
        expect(list?.querySelectorAll(':scope > dd').length).toBe(0);

        const rows = [...(list?.children ?? [])];
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.querySelectorAll(':scope > dt')).toHaveLength(1);
            expect(row.querySelectorAll(':scope > dd')).toHaveLength(1);
            expect(row.className).toContain('grid-cols-subgrid');
            expect(row.className).toContain('min-h-6');
        }
        expect(rows.map((row) => row.querySelector('dt')?.textContent)).toEqual(['Author', 'Updated', 'Labels']);
    });
});
