// Run with: bun packages/ui/tests/chat-history-scroll.browser.mjs
// Uses production React and the installed LegendList in a real Chromium page.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
    CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait,
} from '../../../scripts/perf/cdp.mjs';
import { createFixtureDir, serveFixture } from '../../../scripts/perf/fixture-page.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
// Prepend compensation loses sub-pixel remainders when row estimates are
// fractional, and whether they are depends on the measured average. One
// height profile can pass by luck, so the scenarios run over several.
const heightProfiles = [[5, 137], [7, 137], [3, 101], [6, 53], [4, 211]];
// Both layouts run the production per-row estimator. Touch corrections wait
// until the reader stops scrolling.
const modes = [
    { touch: false },
    { touch: true },
];

// Exercise the actual list component and its prop wiring without mounting the
// application or connecting to a user's backend. Only row content and the
// surrounding chat callbacks are supplied by the fixture.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TimelineList } from '@/components/chat/timeline/TimelineList';
import { I18nProvider } from '@/lib/i18n';
import { SyncRuntimeContext } from '@/sync/sync-runtime-context';
import { ChildStoreManager } from '@/sync/child-store';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { createWebAPIs } from ${JSON.stringify(join(repo, 'packages/web/src/api/index.ts'))};
const childStores = new ChildStoreManager();
const apis = createWebAPIs();
const frames = async count => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
};
const params = new URLSearchParams(location.search);
const heightPeriod = Number(params.get('period'));
const heightStep = Number(params.get('step'));
document.documentElement.classList.toggle('mobile-pointer', params.get('touch') === 'true');
// CSS supplies deterministic content heights and delayed image-like growth;
// the real row renderer, estimator, selection hold and list run unchanged.
const sizing = document.createElement('style');
document.head.append(sizing);
const heights = new Map();
const paintHeights = () => {
    sizing.textContent = [...heights].map(([key, height]) =>
        '[data-turn-row="' + key + '"] { height:' + height + 'px; overflow:hidden }'
    ).join('\\n');
};
const rowsFrom = (from, count, older = false) => Array.from({ length: count }, (_, i) => {
    const key = 'row-' + (from + i);
    const height = 180 + ((from + i + 100) % heightPeriod) * heightStep;
    heights.set(key, older ? 90 : height);
    if (older) setTimeout(() => { heights.set(key, height); paintHeights(); }, 180);
    const message = {
        info: { id: key, sessionID: 'history-fixture', role: 'assistant', agent: 'build',
            providerID: 'fixture', modelID: 'fixture', time: { created: 1, completed: 2 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
        parts: [{ id: 'text-' + key, type: 'text',
            text: Array(Math.ceil((height + 40) / 26)).fill('Row ' + key).join('\\n'),
            sessionID: 'history-fixture', messageID: key }],
    };
    paintHeights();
    return {
        key, kind: 'turn-message', messageId: key, slice: null, final: false,
        underFold: false, gapBelow: false,
        entry: { key, kind: 'turn', isLastTurn: false, turn: {
            turnId: key, userMessage: { info: { id: 'prompt-' + key, role: 'user', time: { created: 1 } }, parts: [] },
            assistantMessages: [message],
        } },
    };
});
const noop = () => {};
let list;
const registerList = value => { list = value; };
function App() {
    const [rows, setRows] = React.useState(() => rowsFrom(20, 60));
    const [footerHeight, setFooterHeight] = React.useState(50);
    window.runScenario = async (moveWhileLoading) => {
        await frames(40);
        const scroller = list.getScrollableNode();
        const moveTo = top => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }));
            scroller.scrollTop = top;
        };
        // A reader scrolls up in steps. The list holds the end it opened at
        // (initialScrollAtEnd) until a scroll it counts as the user's, and a
        // single jump can land while its initial scroll is still settling;
        // the hold then brings the end back with the prepend.
        moveTo(1200);
        await frames(10);
        moveTo(moveWhileLoading ? 600 : 0);
        await frames(40);
        // The request begins here. The reader can keep scrolling before the
        // page arrives; preservation must use their latest visible position.
        if (moveWhileLoading) {
            await new Promise(resolve => setTimeout(resolve, 80));
            moveTo(100);
            await frames(10);
        }
        const visible = [...scroller.querySelectorAll('[data-turn-row]')].find(
            node => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 1,
        );
        if (!visible) throw new Error('No visible anchor');
        const key = visible.dataset.turnRow;
        const read = () => {
            const node = scroller.querySelector('[data-turn-row="' + key + '"]');
            return node ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
        };
        const before = read();
        const samples = [];
        setRows(current => [...rowsFrom(0, 20, true), ...current]);
        const started = performance.now();
        for (let i = 0; i < 70; i++) {
            await frames(1);
            // Read after the frame's layout/ResizeObserver work, not halfway
            // through the pre-paint measurement and scroll compensation pass.
            await new Promise(resolve => setTimeout(resolve, 0));
            samples.push(read());
        }
        const elapsed = performance.now() - started;
        const after = read();
        setFooterHeight(500);
        setRows(current => [...current, ...rowsFrom(80, 1)]);
        await frames(20);
        const tailGrowthShift = read() - after;
        return {
            key, before, after, elapsed, frameCount: samples.length,
            dataCount: list.getState().data.length,
            missingFrames: samples.filter(value => value === null).length,
            maxShift: Math.max(...samples.filter(value => value !== null).map(value => Math.abs(value - before))),
            tailGrowthShift,
        };
    };
    // A steady scroll toward older rows, far from the start, through rows
    // whose estimate exceeds its painted content. Each one measured above the reader
    // is a size correction. Every frame checks whether the list moved
    // scrollTop on its own; on touch that has to wait until the scroll stops.
    window.runScrollScenario = async () => {
        await frames(40);
        const scroller = list.getScrollableNode();
        const set = top => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -30, bubbles: true }));
            scroller.scrollTop = top;
        };
        set(scroller.scrollTop - 1200);
        await frames(10);
        set(scroller.scrollTop - 1200);
        await frames(10);
        let expected = scroller.scrollTop;
        const startTop = expected;
        const corrections = [];
        for (let i = 0; i < 60; i++) {
            expected -= 30;
            set(expected);
            await frames(1);
            await new Promise(resolve => setTimeout(resolve, 0));
            const deviation = scroller.scrollTop - expected;
            if (Math.abs(deviation) > 1) corrections.push(Math.round(deviation));
            expected = scroller.scrollTop;
        }
        const visible = [...scroller.querySelectorAll('[data-turn-row]')].find(
            node => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 1,
        );
        const key = visible.dataset.turnRow;
        const read = () => {
            const node = scroller.querySelector('[data-turn-row="' + key + '"]');
            return node ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
        };
        const atStop = read();
        const topAtStop = scroller.scrollTop;
        await new Promise(resolve => setTimeout(resolve, 600));
        await frames(5);
        return {
            startTop: Math.round(startTop), endTop: Math.round(topAtStop),
            corrections: corrections.length, correctedPx: corrections.reduce((sum, value) => sum + value, 0),
            correctedAtRestPx: Math.round(scroller.scrollTop - topAtStop),
            restShift: read() === null ? null : read() - atStop,
        };
    };
    return <TimelineList
        rows={rows} stickyRowIndices={undefined} showReasoningTraces={false} collapsibleThinkingBlocks={false}
        registerList={registerList} endPinningReleased={true}
        composerOverlayHeight={0} onIsAtEndChange={noop} onListMetricsChange={noop}
        onTimelineDataChange={noop} rowContext={{
            sessionIsWorking: false, turnExpansion: new Map(), onToggleTurnActivity: noop,
            shouldAnimateUserMessage: () => false, onUserAnimationConsumed: noop,
            streamingTailKey: null, activeStreamingMessageId: null, activeStreamingPhase: null,
        }}
        // The chat's fixed 48 px "Load older" slot (ChatContainer.tsx). With
        // nothing above the rows, a reader at scrollTop 0 is at the list's
        // start, and the list shows a prepend from the top in any version.
        listHeader={<div style={{ height: 48 }} />}
        listFooter={<div style={{ height: footerHeight }} />}
        scrollContainerProps={{ style: { height: 600, width: 800, overflow: 'auto', overflowAnchor: 'none' } }}
    />;
}
createRoot(document.getElementById('root')).render(
    <SyncRuntimeContext.Provider value={{ childStores }}>
        <RuntimeAPIProvider apis={apis}><I18nProvider><App /></I18nProvider></RuntimeAPIProvider>
    </SyncRuntimeContext.Provider>
);
`;

const fixtureDir = createFixtureDir('history-scroll', 'packages/ui/tmp');
let server;
let chrome;
let client;
try {
    writeFileSync(join(fixtureDir, 'fixture.tsx'), fixture);
    writeFileSync(join(fixtureDir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
    const chromePath = resolveChrome();
    server = await serveFixture({ root: fixtureDir });
    const origin = server.url;
    const port = await reservePort();
    chrome = launchChrome({ chrome: chromePath, port, profileDir: join(fixtureDir, 'profile'), headless: true });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const exceptions = [];
    client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails));
    for (const mode of modes) for (const [period, step] of heightProfiles) for (const moveWhileLoading of [false, true]) {
        const loaded = client.once('Page.loadEventFired');
        await client.send('Page.navigate', {
            url: `${origin}?moving=${moveWhileLoading}&period=${period}&step=${step}&touch=${mode.touch}`,
        });
        await loaded;
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            ready = await evaluateValue(client, 'typeof window.runScenario === "function"');
            if (ready) break;
            await wait(100);
        }
        assert.ok(ready, 'The browser fixture mounted');
        const result = await evaluateValue(client, `window.runScenario(${moveWhileLoading})`);
        console.log(JSON.stringify({ ...mode, period, step, moveWhileLoading, ...result }));
        assert.deepEqual(exceptions, [], 'No browser runtime errors');
        assert.equal(result.dataCount, 81, 'The prepend and tail append actually committed');
        assert.equal(result.frameCount, 70);
        assert.ok(result.elapsed < 5_000, 'The renderer was producing frames without background throttling');
        assert.equal(result.missingFrames, 0, 'The visible row stayed mounted');
        assert.ok(result.maxShift <= 1, `History shifted the visible anchor by ${result.maxShift}px`);
        assert.ok(Math.abs(result.tailGrowthShift) <= 1, 'Content below the reader must not move them');
    }
    // The touch layout's deferral: without it the list corrects scrollTop
    // during the scroll (the control that the scenario makes corrections);
    // with it, nothing moves until the scroll stops, and the reader's row
    // stays put through the one correction at rest.
    const scrolls = {};
    for (const touch of [false, true]) {
        const loaded = client.once('Page.loadEventFired');
        await client.send('Page.navigate', { url: `${origin}?period=5&step=137&touch=${touch}` });
        await loaded;
        for (let attempt = 0; attempt < 100 && !(await evaluateValue(client, 'typeof window.runScrollScenario === "function"')); attempt++) await wait(100);
        scrolls[touch] = await evaluateValue(client, 'window.runScrollScenario()');
        console.log(JSON.stringify({ scroll: true, touch, ...scrolls[touch] }));
        assert.deepEqual(exceptions, [], 'No browser runtime errors');
        assert.ok(scrolls[touch].startTop > 2400, 'The scroll stays more than two viewports from the start');
    }
    assert.ok(scrolls[false].corrections > 0, 'Rows measured above the reader correct the scroll position');
    assert.equal(scrolls[true].corrections, 0, 'On touch, corrections wait until the scroll stops');
    assert.ok(Math.abs(scrolls[true].correctedAtRestPx) > 1, 'The deferred correction lands at rest');
    assert.ok(scrolls[true].restShift !== null && Math.abs(scrolls[true].restShift) <= 1, `The correction at rest moved the reader's row by ${scrolls[true].restShift}px`);
} finally {
    client?.socket.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        const exited = new Promise(resolve => chrome.once('exit', resolve));
        chrome.kill();
        await exited;
    }
    await server?.close();
    rmSync(fixtureDir, { recursive: true, force: true });
}
