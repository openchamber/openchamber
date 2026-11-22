// Run with: bun packages/ui/tests/chat-history-scroll.browser.mjs
// Uses production React and the installed LegendList in a real Chromium page.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait,
} from '../../../scripts/perf/cdp.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = readFileSync(join(repo, 'packages/ui/src/components/chat/MessageList.tsx'), 'utf8');
const start = source.indexOf('type TimelineListProps =');
const end = source.indexOf("TimelineList.displayName = 'TimelineList';", start);
assert.ok(start >= 0 && end > start, 'Locate the production TimelineList component');
const estimatedSize = source.match(/^const TIMELINE_ESTIMATED_ENTRY_SIZE = .+;$/m)?.[0];
assert.ok(estimatedSize, 'Use the production row size estimate');
// Resolve the list the UI package actually installs; a stale hoisted copy at
// the repository root would otherwise be measured instead.
const legendList = join(
    dirname(createRequire(join(repo, 'packages/ui/package.json')).resolve('@legendapp/list/react')),
    'react.mjs',
);
// Prepend compensation loses sub-pixel remainders when row estimates are
// fractional, and whether they are depends on the measured average. One
// height profile can pass by luck, so the scenarios run over several.
const heightProfiles = [[5, 137], [7, 137], [3, 101], [6, 53], [4, 211]];

// Exercise the actual list component and its prop wiring without mounting the
// application or connecting to a user's backend. Only row content and the
// surrounding chat callbacks are supplied by the fixture.
const fixture = `
import React from ${JSON.stringify(join(repo, 'node_modules/react/index.js'))};
import { createRoot } from ${JSON.stringify(join(repo, 'node_modules/react-dom/client.js'))};
import { LegendList } from ${JSON.stringify(legendList)};
${estimatedSize}
const TimelineRowContext = React.createContext(null);
const useUIStore = () => true;
const resolveTimelineIsAtEnd = () => false;
const timelineKeyExtractor = item => item.key;
const timelineItemType = item => item.kind;
function Row({ item }) {
    const [settled, setSettled] = React.useState(!item.older);
    React.useEffect(() => {
        if (settled) return;
        const timer = setTimeout(() => setSettled(true), 180);
        return () => clearTimeout(timer);
    }, [settled]);
    return <div data-probe-id={item.key} style={{ height: settled ? item.height : 90 }}>
        Row {item.key}
    </div>;
}
const renderTimelineItem = ({ item }) => <Row item={item} />;
// The production logTimelineReadiness sits above the sliced component and is
// gated on a localStorage debug flag. The fixture records every call instead,
// so the footer scenario can count readiness cycles directly.
const timelineReadinessLog = [];
window.__timelineReadinessLog = timelineReadinessLog;
let footerResizeScheduled = false;
const logTimelineReadiness = (event, entries, footerSize, cycle) => {
    timelineReadinessLog.push({ event, entries, footerSize, cycle });
};
${source.slice(start, end)}
const frames = async count => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
};
const params = new URLSearchParams(location.search);
const heightPeriod = Number(params.get('period'));
const heightStep = Number(params.get('step'));
const footerBootstrapProbe = params.get('footerBootstrap') === '1';
const rowsFrom = (from, count, older = false) => Array.from({ length: count }, (_, i) => ({
    key: 'row-' + (from + i), kind: 'turn', height: 180 + ((from + i + 100) % heightPeriod) * heightStep, older,
}));
const noop = () => {};
let list;
function App() {
    const [rows, setRows] = React.useState(() => rowsFrom(20, 60));
    const [footerHeight, setFooterHeight] = React.useState(50);
    window.__resizeFooter = () => setFooterHeight(500);
    const registerList = React.useCallback(value => {
        list = value;
        if (value && footerBootstrapProbe) {
            window.__registeredFooterTarget = value.getState().__initialScroll?.preserveForFooterLayout ?? false;
            if (!footerResizeScheduled) {
                footerResizeScheduled = true;
                queueMicrotask(() => window.__resizeFooter?.());
            }
        }
    }, []);
    window.runScenario = async (moveWhileLoading) => {
        await frames(40);
        const scroller = list.getScrollableNode();
        const moveTo = top => {
            scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }));
            scroller.scrollTop = top;
        };
        moveTo(moveWhileLoading ? 600 : 0);
        await frames(40);
        // The request begins here. The reader can keep scrolling before the
        // page arrives; preservation must use their latest visible position.
        if (moveWhileLoading) {
            await new Promise(resolve => setTimeout(resolve, 80));
            moveTo(100);
            await frames(10);
        }
        const visible = [...scroller.querySelectorAll('[data-probe-id]')].find(
            node => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 1,
        );
        if (!visible) throw new Error('No visible anchor');
        const key = visible.dataset.probeId;
        const read = () => {
            const node = scroller.querySelector('[data-probe-id="' + key + '"]');
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
    window.runFooterResizeScenario = async () => {
        const readyCount = () => timelineReadinessLog.filter(entry => entry.event === 'ready').length;
        // Resize in the same beat as a data change, as in production (a
        // permission arrives, a turn ends): the list still holds its preserved
        // end target then, which is exactly the window where a footer present
        // at mount used to re-run readiness and blank the transcript (#52).
        // A resize long after the list settles touches no initial-scroll
        // state in either version and would prove nothing.
        for (let i = 0; i < 200 && readyCount() === 0; i++) await frames(1);
        if (!footerBootstrapProbe) {
            setRows(current => [...current, ...rowsFrom(80, 1)]);
            for (let i = 0; i < 200 && list.getState().data.length !== 61; i++) await frames(1);
            await frames(5);
        }
        const scroller = list.getScrollableNode();
        const anchor = [...scroller.querySelectorAll('[data-probe-id]')].find(node => {
            const rect = node.getBoundingClientRect();
            const bounds = scroller.getBoundingClientRect();
            return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
        });
        if (!anchor) throw new Error('No visible anchor');
        const key = anchor.dataset.probeId;
        const read = () => {
            const node = scroller.querySelector('[data-probe-id="' + key + '"]');
            if (!node) return null;
            let opacity = 1;
            for (let current = node; current && current !== scroller; current = current.parentElement) {
                opacity = Math.min(opacity, Number(getComputedStyle(current).opacity));
            }
            return { top: node.getBoundingClientRect().top - scroller.getBoundingClientRect().top, opacity };
        };
        const before = read();
        if (!before) throw new Error('Anchor vanished before the resize');
        const readyBefore = readyCount();
        const samples = [];
        setFooterHeight(500);
        for (let i = 0; i < 70; i++) {
            await frames(1);
            // Match the history scenario: read after layout/ResizeObserver work.
            await new Promise(resolve => setTimeout(resolve, 0));
            samples.push(read());
        }
        await frames(20);
        return {
            key,
            dataCount: list.getState().data.length,
            registeredFooterTarget: window.__registeredFooterTarget,
            readyBefore,
            readyAfter: readyCount(),
            footerSizes: timelineReadinessLog.filter(entry => entry.event === 'footer').map(entry => entry.footerSize),
            missingFrames: samples.filter(value => value === null).length,
            blankFrames: samples.filter(value => value !== null && value.opacity === 0).length,
            maxShift: Math.max(...samples.filter(value => value !== null).map(value => Math.abs(value.top - before.top))),
        };
    };
    return <TimelineList
        entries={rows} registerList={registerList} endPinningReleased={true}
        composerOverlayHeight={0} onIsAtEndChange={noop}
        onListMetricsChange={noop}
        onTimelineDataChange={noop}
        rowContext={{ sessionIsWorking: false }}
        listFooter={<div style={{ height: footerHeight }} />}
        scrollContainerProps={{ style: { height: 600, width: 800, overflow: 'auto', overflowAnchor: 'none' } }}
    />;
}
createRoot(document.getElementById('root')).render(<App />);
`;

const build = await Bun.build({
    entrypoints: ['history-fixture'],
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
        name: 'history-fixture',
        setup(builder) {
            builder.onResolve({ filter: /^history-fixture$/ }, () => ({ path: 'entry', namespace: 'fixture' }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'tsx' }));
            builder.onLoad({ filter: /@legendapp\/list\/react\.mjs$/ }, args => {
                if (args.path !== legendList) return undefined;
                const source = readFileSync(args.path, 'utf8');
                const marker = 'getState: () => ({';
                assert.ok(source.includes(marker), 'Locate the installed LegendList state accessor');
                return {
                    contents: source.replace(marker, `${marker}\n      __initialScroll: state.initialScroll,`),
                    loader: 'js',
                    resolveDir: dirname(args.path),
                };
            });
            // React 19 provides the hook that the compatibility shim delegates to.
            builder.onResolve({ filter: /^use-sync-external-store\/shim$/ }, () => ({ path: 'shim', namespace: 'react-shim' }));
            builder.onLoad({ filter: /.*/, namespace: 'react-shim' }, () => ({
                contents: `export { useSyncExternalStore } from ${JSON.stringify(join(repo, 'node_modules/react/index.js'))};`,
                loader: 'js',
            }));
        },
    }],
});
assert.ok(build.success, build.logs.join('\n'));
const javascript = await build.outputs[0].text();
const chromePath = resolveChrome(process.env.CHROME_PATH);
const profileDir = mkdtempSync(join(tmpdir(), 'openchamber-history-scroll-'));
const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
        return new URL(request.url).pathname === '/app.js'
            ? new Response(javascript, { headers: { 'Content-Type': 'application/javascript' } })
            : new Response('<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>', {
                headers: { 'Content-Type': 'text/html' },
            });
    },
});
const port = await reservePort();
const chrome = launchChrome({ chrome: chromePath, port, profileDir, headless: true });
let client;
try {
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const exceptions = [];
    client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails));
    for (const [period, step] of heightProfiles) for (const moveWhileLoading of [false, true]) {
        const loaded = client.once('Page.loadEventFired');
        await client.send('Page.navigate', {
            url: `http://127.0.0.1:${server.port}/?moving=${moveWhileLoading}&period=${period}&step=${step}`,
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
        console.log(JSON.stringify({ period, step, moveWhileLoading, ...result }));
        assert.deepEqual(exceptions, [], 'No browser runtime errors');
        assert.equal(result.dataCount, 81, 'The prepend and tail append actually committed');
        assert.equal(result.frameCount, 70);
        assert.ok(result.elapsed < 5_000, 'The renderer was producing frames without background throttling');
        assert.equal(result.missingFrames, 0, 'The visible row stayed mounted');
        assert.ok(result.maxShift <= 1, `History shifted the visible anchor by ${result.maxShift}px`);
        assert.ok(Math.abs(result.tailGrowthShift) <= 1, 'Content below the reader must not move them');
    }
        // Footer-deferral regression (#872, PR #721): on a fresh end-aligned
        // mount, resizing the footer must not blank the transcript (the #52
        // bug) or re-run readiness for the same row count.
        const [footerPeriod, footerStep] = heightProfiles[0];
        const footerLoaded = client.once('Page.loadEventFired');
        await client.send('Page.navigate', {
            url: `http://127.0.0.1:${server.port}/?moving=false&period=${footerPeriod}&step=${footerStep}`,
        });
        await footerLoaded;
        let footerReady = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            footerReady = await evaluateValue(client, 'typeof window.runFooterResizeScenario === "function"');
            if (footerReady) break;
            await wait(100);
        }
        assert.ok(footerReady, 'The browser fixture mounted for the footer scenario');
        const footerResult = await evaluateValue(client, 'window.runFooterResizeScenario()');
        console.log(JSON.stringify({ scenario: 'footer-resize', period: footerPeriod, step: footerStep, ...footerResult }));
        assert.deepEqual(exceptions, [], 'No browser runtime errors');
        assert.equal(footerResult.dataCount, 61, 'The footer scenario appended exactly one row before the resize');
        assert.ok(footerResult.readyBefore >= 1, 'Readiness instrumentation recorded the mount cycle');
        assert.ok(footerResult.footerSizes.includes(500), 'The footer resize was actually measured');
        assert.equal(footerResult.readyAfter, footerResult.readyBefore, 'A footer resize must not re-run readiness for the same row count');
        assert.equal(footerResult.missingFrames, 0, 'The visible row stayed mounted during the footer resize');
        assert.equal(footerResult.blankFrames, 0, 'No row container rendered at opacity 0 during the footer resize');
        assert.ok(footerResult.maxShift <= 1, `Footer resize shifted the visible anchor by ${footerResult.maxShift}px`);

        // Read LegendList's target at registration, before the queued footer
        // resize. A footer present on the first render preserves this target.
        const productionFooterLoaded = client.once('Page.loadEventFired');
        await client.send('Page.navigate', {
            url: `http://127.0.0.1:${server.port}/?footerBootstrap=1&period=${footerPeriod}&step=${footerStep}`,
        });
        await productionFooterLoaded;
        let productionFooterReady = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            productionFooterReady = await evaluateValue(client, 'typeof window.runFooterResizeScenario === "function"');
            if (productionFooterReady) break;
            await wait(100);
        }
        assert.ok(productionFooterReady, 'The browser fixture mounted for the preserved-target probe');
        const productionFooterResult = await evaluateValue(client, 'window.runFooterResizeScenario()');
        console.log(JSON.stringify({ scenario: 'footer-resize-preserved-target', period: footerPeriod, step: footerStep, ...productionFooterResult }));
        assert.deepEqual(exceptions, [], 'No browser runtime errors during the preserved-target probe');
        assert.equal(productionFooterResult.dataCount, 60, 'The probe keeps the initial timeline unchanged');
        assert.equal(productionFooterResult.registeredFooterTarget, false, 'The production deferral must keep the footer out of LegendList initial target state');
        assert.equal(productionFooterResult.readyBefore, 1, 'The queued footer resize must not trigger another readiness cycle');
        assert.ok(productionFooterResult.footerSizes.includes(500), 'The footer resize was measured');
        assert.equal(productionFooterResult.readyAfter, productionFooterResult.readyBefore, 'The footer resize must not re-run readiness');
        assert.equal(productionFooterResult.missingFrames, 0, 'The visible row stayed mounted during the footer resize');
        assert.equal(productionFooterResult.blankFrames, 0, 'No row container rendered at opacity 0 during the footer resize');
} finally {
    client?.socket.close();
    if (chrome.exitCode === null && chrome.signalCode === null) {
        const exited = new Promise(resolve => chrome.once('exit', resolve));
        chrome.kill();
        await exited;
    }
    server.stop(true);
    rmSync(profileDir, { recursive: true, force: true });
}
