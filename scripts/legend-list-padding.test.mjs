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
// makes a missing patch or a changed upstream implementation fail this check.
function controller(bundle, { horizontal = false, baseline = '' } = {}) {
    const source = readFileSync(join(packageDirectory, bundle), 'utf8');
    const start = source.indexOf('function ScrollAdjust() {');
    const end = source.indexOf('var SnapWrapper', start);
    assert.ok(start >= 0 && end > start, "Find the pinned package version's ScrollAdjust implementation");

    const hooks = { useRef: (value) => ({ current: value }), useCallback: (callback) => callback };
    const signals = new Map([['scrollAdjust', 0], ['scrollAdjustUserOffset', 0]]);
    const listeners = new Map();
    const frames = new Map();
    let frameId = 0;
    const paddingKey = horizontal ? 'paddingRight' : 'paddingBottom';
    let padding = baseline;
    const style = {};
    Object.defineProperty(style, paddingKey, {
        get: () => padding,
        set(value) {
            // Observed in Chromium: assigning 2123.1875px reads back as
            // 2123.19px. This normalization is what a plain JS style mock misses.
            padding = value.endsWith('px') ? `${Number(Number.parseFloat(value).toPrecision(6))}px` : value;
        },
    });
    const contentNode = {
        style,
        get scrollHeight() { return 300 + (Number.parseFloat(padding) || 0); },
        get scrollWidth() { return 300 + (Number.parseFloat(padding) || 0); },
        get offsetHeight() { return this.scrollHeight; },
    };
    const scrollElement = {
        scrollTop: 0, scrollLeft: 0, clientHeight: 300, clientWidth: 300,
        scrollBy({ left, top }) { this.scrollLeft += left; this.scrollTop += top; },
    };
    const ctx = { state: { props: { horizontal }, scroll: 0, adjustingFromInitialMount: false } };
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
            paddingEndProp: paddingKey,
        }),
        scrollAdjustBy: (element, left, top) => element.scrollBy({ left, top }),
        window: { getComputedStyle: () => style },
        requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: (id) => frames.delete(id),
    });
    ScrollAdjust();
    return {
        get padding() { return padding; },
        set padding(value) { style[paddingKey] = value; },
        adjust(offset) {
            signals.set('scrollAdjustUserOffset', offset);
            listeners.get('scrollAdjustUserOffset')();
        },
        finishFrame() {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback();
        },
    };
}

for (const bundle of bundles) {
    describe(`LegendList temporary padding: ${bundle}`, () => {
        it('removes browser-rounded fractional padding on the next frame', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            assert.equal(view.padding, '2123.19px');
            view.finishFrame();
            assert.equal(view.padding, '');
        });

        it('preserves the original baseline across overlapping adjustments', () => {
            const view = controller(bundle, { baseline: '12px' });
            view.adjust(1061.59375);
            view.adjust(5000.25);
            view.finishFrame();
            assert.equal(view.padding, '12px');
        });

        it('cleans up the horizontal web entry point too', () => {
            const view = controller(bundle, { horizontal: true });
            view.adjust(1061.59375);
            view.finishFrame();
            assert.equal(view.padding, '');
        });

        it('does not clear padding changed by another owner', () => {
            const view = controller(bundle);
            view.adjust(1061.59375);
            view.padding = '28px';
            view.finishFrame();
            assert.equal(view.padding, '28px');
        });
    });
}
