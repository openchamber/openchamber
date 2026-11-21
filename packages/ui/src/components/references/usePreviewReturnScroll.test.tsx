import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { usePreviewReturnScroll } from './usePreviewReturnScroll';

const installDom = () => {
    const dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    return dom;
};

const scrollerIn = (host: HTMLElement): HTMLDivElement => {
    const node = host.querySelector('[data-testid="scroller"]');
    if (!(node instanceof window.HTMLDivElement)) throw new Error('the test scroller did not render');
    return node;
};

test('a preview opens at its top and the list returns to where it was', async () => {
    installDom();
    const { createRoot } = await import('react-dom/client');
    const { flushSync } = await import('react-dom');

    const host = document.createElement('div');
    document.body.appendChild(host);

    // The browser clamps the list's offset to the shorter preview as soon as it
    // replaces it; `clamp` is that clamped offset.
    const Probe = ({ previewKey, clamp }: { previewKey: string | null; clamp: number }) => {
        React.useLayoutEffect(() => {
            if (previewKey === null) return;
            const node = host.querySelector('[data-testid="scroller"]');
            if (node) node.scrollTop = clamp;
        }, [previewKey, clamp]);
        const scrollerRef = usePreviewReturnScroll(previewKey);
        return <div ref={scrollerRef} data-testid="scroller" />;
    };

    const root = createRoot(host);
    const render = (previewKey: string | null, clamp: number) => act(async () => {
        root.render(<Probe previewKey={previewKey} clamp={clamp} />);
    });

    await render(null, 0);
    const scroller = scrollerIn(host);
    scroller.scrollTop = 900;
    await act(async () => { scroller.dispatchEvent(new window.Event('scroll')); });

    // The clamp's scroll event lands after the commit; it must not replace
    // the place the list left with the clamped offset.
    let resetTo = -1;
    await act(async () => {
        flushSync(() => root.render(<Probe previewKey="a" clamp={100} />));
        resetTo = scroller.scrollTop;
        scroller.scrollTop = 100;
        scroller.dispatchEvent(new window.Event('scroll'));
    });
    expect(resetTo).toBe(0);

    // The next item also starts at its top, and the clamped offset never
    // replaces the place the list left.
    let nextTo = -1;
    await act(async () => {
        flushSync(() => root.render(<Probe previewKey="b" clamp={100} />));
        nextTo = scroller.scrollTop;
    });
    expect(nextTo).toBe(0);

    await render(null, 0);
    expect(scroller.scrollTop).toBe(900);

    await act(async () => { root.unmount(); });
});

test('a replaced scroller keeps tracking the list', async () => {
    installDom();
    const { createRoot } = await import('react-dom/client');

    const host = document.createElement('div');
    document.body.appendChild(host);

    const Probe = ({ nodeKey, previewKey }: { nodeKey: string; previewKey: string | null }) => {
        const scrollerRef = usePreviewReturnScroll(previewKey);
        return <div key={nodeKey} ref={scrollerRef} data-testid="scroller" />;
    };

    const root = createRoot(host);
    const render = (nodeKey: string, previewKey: string | null) => act(async () => {
        root.render(<Probe nodeKey={nodeKey} previewKey={previewKey} />);
    });

    await render('first', null);
    const first = scrollerIn(host);
    const unbound = spyOn(first, 'removeEventListener');
    first.scrollTop = 900;
    await act(async () => { scrollerIn(host).dispatchEvent(new window.Event('scroll')); });

    // The surface crosses the phone layout threshold, or a boundary retries:
    // the scroller is a new element while the hook stays mounted.
    await render('second', null);
    expect(unbound).toHaveBeenCalled();
    expect(unbound.mock.calls[0]?.[0]).toBe('scroll');
    const replaced = scrollerIn(host);
    expect(replaced.scrollTop).toBe(0);

    // The new scroller never showed the old element's offset: returning must
    // not jump it to where the destroyed one was.
    await render('second', 'item');
    expect(replaced.scrollTop).toBe(0);
    await render('second', null);
    expect(replaced.scrollTop).toBe(0);

    // Tracking follows the new element.
    replaced.scrollTop = 500;
    await act(async () => { replaced.dispatchEvent(new window.Event('scroll')); });

    await render('second', 'item');
    expect(replaced.scrollTop).toBe(0);
    await render('second', null);
    expect(replaced.scrollTop).toBe(500);

    await act(async () => { root.unmount(); });
});
