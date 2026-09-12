import React, { act, StrictMode, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { LiveActivityCollapse } from './LiveActivityCollapse';

describe('live Activity collapse layout lifecycle', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;

    beforeEach(() => {
        const win = new Window({ url: 'http://localhost' });
        const globals = {
            window: win, document: win.document, HTMLElement: win.HTMLElement,
            Element: win.Element, SVGElement: win.SVGElement, NodeList: win.NodeList,
            requestAnimationFrame: win.requestAnimationFrame.bind(win),
            cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win),
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        restore();
    });

    test('settles the target height when React cleans up and replays a collapse layout effect', async () => {
        await act(async () => root.render(
            <StrictMode>
                <LiveActivityCollapse expanded={false} animateOnMount>
                    <div ref={(node) => {
                        if (!node?.parentElement) return;
                        // Happy DOM has no layout engine. Supply the height
                        // measured before a real historical turn collapses.
                        Object.defineProperty(node.parentElement, 'scrollHeight', { configurable: true, get: () => 2400 });
                    }}>Historical activity</div>
                </LiveActivityCollapse>
            </StrictMode>,
        ));
        const region = container.querySelector<HTMLElement>('[data-live-activity-content]');
        expect(region?.style.height).toBe('0px');
        expect(region?.childElementCount).toBe(0);
    });

    test('settles a collapse after a Suspense hide/reveal in production lifecycle', async () => {
        let suspended = false;
        let release: () => void = () => undefined;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        function LoadingSibling() {
            if (suspended) throw pending;
            return null;
        }
        const render = () => (
            <Suspense fallback={<div>Loading history</div>}>
                <LiveActivityCollapse expanded={false} animateOnMount>
                    <div ref={(node) => {
                        if (!node?.parentElement) return;
                        Object.defineProperty(node.parentElement, 'scrollHeight', { configurable: true, get: () => 2400 });
                    }}>Historical activity</div>
                </LiveActivityCollapse>
                <LoadingSibling />
            </Suspense>
        );
        await act(async () => root.render(render()));
        suspended = true;
        await act(async () => root.render(render()));
        suspended = false;
        await act(async () => { release(); });
        const region = container.querySelector<HTMLElement>('[data-live-activity-content]');
        expect(region?.style.height).toBe('0px');
        expect(region?.childElementCount).toBe(0);
    });

    test('restores natural height when an expansion is interrupted by Suspense', async () => {
        let expanded = false;
        let suspended = false;
        let release: () => void = () => undefined;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        function LoadingSibling() {
            if (suspended) throw pending;
            return null;
        }
        const render = () => (
            <Suspense fallback={<div>Loading history</div>}>
                <LiveActivityCollapse expanded={expanded}>
                    <div>Historical activity</div>
                </LiveActivityCollapse>
                <LoadingSibling />
            </Suspense>
        );
        await act(async () => root.render(render()));
        expanded = true;
        await act(async () => root.render(render()));
        suspended = true;
        await act(async () => root.render(render()));
        suspended = false;
        await act(async () => { release(); });
        const region = container.querySelector<HTMLElement>('[data-live-activity-content]');
        expect(region?.style.height).toBe('auto');
        expect(region?.style.overflow).toBe('visible');
        expect(region?.textContent).toBe('Historical activity');
    });
});
