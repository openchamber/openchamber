import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const requireUI = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const packageDirectory = dirname(requireUI.resolve('@legendapp/list/react'));
const bundles = ['react.js', 'react.mjs', 'react-native.web.js', 'react-native.web.mjs'];

// Exercise the installed dependency's actual private ScrollAdjust controller.
// Only its external hooks, DOM geometry and frame scheduler are supplied here.
// Keeping the controller in the package (rather than copying it into a test)
// makes a regressed or changed upstream implementation fail this check.
//
// When a scroll correction would land past the end of the content (a history
// prepend near the end), the controller makes room with a temporary spacer
// appended to the content node and removes it on the next frame. A spacer
// left behind is a phantom tail below the last row.
function controller(bundle, { horizontal = false } = {}) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function ScrollAdjust() {');
    const end = source.indexOf('var SnapWrapper', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's ScrollAdjust implementation");

    const layoutEffects = [];
    const hooks = {
        useRef: (value) => ({ current: value }),
        useCallback: (callback) => callback,
        useLayoutEffect: (effect) => layoutEffects.push(effect),
    };
    const signals = new Map([['scrollAdjust', 0], ['scrollAdjustUserOffset', 0]]);
    const listeners = new Map();
    const frames = new Map();
    let frameId = 0;
    const sizeProp = horizontal ? 'width' : 'height';
    const children = [];
    const contentNode = {
        ownerDocument: {
            createElement() {
                const element = {
                    style: {},
                    parentElement: null,
                    setAttribute() {},
                    get offsetHeight() { return Number.parseFloat(element.style.height) || 0; },
                    remove() {
                        const index = children.indexOf(element);
                        if (index >= 0) children.splice(index, 1);
                        element.parentElement = null;
                    },
                };
                return element;
            },
        },
        appendChild(element) {
            children.push(element);
            element.parentElement = contentNode;
        },
        get scrollHeight() { return 300 + spacerSize(); },
        get scrollWidth() { return 300 + spacerSize(); },
    };
    const spacerSize = () => children.reduce((sum, child) => sum + (Number.parseFloat(child.style[sizeProp]) || 0), 0);
    const scrollElement = {
        scrollTop: 0, scrollLeft: 0, clientHeight: 300, clientWidth: 300,
        scrollBy({ left, top }) { this.scrollLeft += left; this.scrollTop += top; },
    };
    const ctx = { state: { props: { horizontal }, scroll: 0, adjustingFromInitialMount: false, refScroller: { current: null } } };
    const ScrollAdjust = runInNewContext(`(${source.slice(start, end).trim()})`, {
        React3: hooks,
        React3__namespace: hooks,
        useStateContext: () => ctx,
        peek$: (_ctx, key) => signals.get(key),
        useValueListener$: (key, callback) => listeners.set(key, callback),
        getScrollAdjustTarget: () => ({ contentNode, scrollElement }),
        getScrollAdjustAxis: () => ({
            x: horizontal ? 1 : 0, y: horizontal ? 0 : 1,
            contentSizeKey: horizontal ? 'scrollWidth' : 'scrollHeight',
            viewportSizeKey: horizontal ? 'clientWidth' : 'clientHeight',
            sizeProp,
        }),
        scrollAdjustBy: (element, left, top) => element.scrollBy({ left, top }),
        requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: (id) => frames.delete(id),
    });
    ScrollAdjust();
    const cleanups = layoutEffects.map((effect) => effect()).filter(Boolean);
    return {
        children,
        spacerSize,
        get scroll() { return horizontal ? scrollElement.scrollLeft : scrollElement.scrollTop; },
        adjust(offset) {
            signals.set('scrollAdjustUserOffset', offset);
            listeners.get('scrollAdjustUserOffset')();
        },
        finishFrame() {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback();
        },
        unmount() {
            for (const cleanup of cleanups) cleanup();
        },
    };
}

for (const bundle of bundles) {
    describe(`LegendList temporary end space: ${bundle}`, () => {
        it('makes room for a correction past the end and removes it on the next frame', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            assert.equal(view.scroll, 1061.59375);
            assert.equal(view.children.length, 1);
            assert.ok(view.spacerSize() >= 1061.59375);
            view.finishFrame();
            assert.equal(view.children.length, 0);
        });

        it('grows one spacer across overlapping corrections and removes it once', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            view.adjust(5000.25);
            assert.equal(view.children.length, 1);
            view.finishFrame();
            assert.equal(view.children.length, 0);
            assert.equal(view.spacerSize(), 0);
        });

        it('cleans up the horizontal web entry point too', () => {
            const view = controller(bundle, { horizontal: true });
            view.adjust(1061.59375);
            assert.equal(view.children.length, 1);
            view.finishFrame();
            assert.equal(view.children.length, 0);
        });

        it('removes the spacer when the list unmounts before the frame', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            view.unmount();
            assert.equal(view.children.length, 0);
        });
    });
}
