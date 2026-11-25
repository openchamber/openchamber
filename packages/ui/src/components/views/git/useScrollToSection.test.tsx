import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const withDom = async (run: (dom: Window) => Promise<void>) => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
        Event: dom.Event, DOMRect: dom.DOMRect, getComputedStyle: dom.getComputedStyle.bind(dom),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    try {
        await run(dom);
    } finally {
        await dom.happyDOM.abort();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
};

const installFrameQueue = (dom: Window) => {
    let next = 0;
    const pending = new Map<number, FrameRequestCallback>();
    Object.defineProperty(dom, 'requestAnimationFrame', {
        configurable: true,
        value: (callback: FrameRequestCallback) => {
            const id = (next += 1);
            pending.set(id, callback);
            return id;
        },
    });
    Object.defineProperty(dom, 'cancelAnimationFrame', {
        configurable: true,
        value: (id: number) => { pending.delete(id); },
    });
    return () => {
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback(0);
    };
};

class FakeResizeObserver implements ResizeObserver {
    static instances: FakeResizeObserver[] = [];
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        FakeResizeObserver.instances.push(this);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    emit() {
        this.callback([], this);
    }
}

const setup = async (dom: Window) => {
    FakeResizeObserver.instances = [];
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
    const flushFrames = installFrameQueue(dom);
    const { createRoot } = await import('react-dom/client');
    const { useScrollToSection } = await import('./useScrollToSection');
    let api: ReturnType<typeof useScrollToSection> | null = null;
    const Probe = () => {
        api = useScrollToSection();
        return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    return { api: () => api!, flushFrames, root };
};

test('keeps a section at the top while the content above it grows', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        let scrolled = 0;
        const node = document.createElement('div');
        document.body.appendChild(node);
        node.scrollIntoView = () => { scrolled += 1; };
        await act(async () => api().registerSectionRef('working:src/taxes.ts', node));
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        expect(scrolled).toBe(1);
        await act(async () => {
            FakeResizeObserver.instances.at(-1)?.emit();
            flushFrames();
        });
        expect(scrolled).toBe(2);
        await act(async () => root.unmount());
    });
});

test('reader input ends the hold', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        let scrolled = 0;
        const node = document.createElement('div');
        document.body.appendChild(node);
        node.scrollIntoView = () => { scrolled += 1; };
        await act(async () => api().registerSectionRef('working:src/taxes.ts', node));
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        expect(scrolled).toBe(1);
        node.dispatchEvent(new Event('wheel'));
        await act(async () => {
            FakeResizeObserver.instances.at(-1)?.emit();
            flushFrames();
        });
        expect(scrolled).toBe(1);
        await act(async () => root.unmount());
    });
});

test('a later request moves the hold to its own section', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        let first = 0;
        let second = 0;
        const firstNode = document.createElement('div');
        document.body.appendChild(firstNode);
        firstNode.scrollIntoView = () => { first += 1; };
        const secondNode = document.createElement('div');
        document.body.appendChild(secondNode);
        secondNode.scrollIntoView = () => { second += 1; };
        await act(async () => api().registerSectionRef('working:src/cart.ts', firstNode));
        await act(async () => api().registerSectionRef('working:src/taxes.ts', secondNode));
        expect(first).toBe(0);
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        expect(second).toBe(1);
        await act(async () => {
            FakeResizeObserver.instances.at(-1)?.emit();
            flushFrames();
        });
        expect(second).toBe(2);
        expect(first).toBe(0);
        await act(async () => root.unmount());
    });
});

const scrollScene = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const parent = document.createElement('div');
    parent.style.overflowY = 'auto';
    const content = document.createElement('div');
    const node = document.createElement('div');
    parent.appendChild(content);
    content.appendChild(node);
    host.appendChild(parent);
    let nodeTop = 800;
    parent.getBoundingClientRect = () => new DOMRect(0, 100, 400, 600);
    node.getBoundingClientRect = () => new DOMRect(0, 100 + nodeTop - parent.scrollTop, 400, 300);
    return { parent, node, setNodeTop: (top: number) => { nodeTop = top; } };
};

test('aligns the scroll parent to the section and follows growth above it', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        const scene = scrollScene();
        await act(async () => api().registerSectionRef('working:src/taxes.ts', scene.node));
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        await act(async () => flushFrames());
        expect(scene.parent.scrollTop).toBe(800);
        scene.setNodeTop(900);
        await act(async () => {
            FakeResizeObserver.instances.at(-1)?.emit();
            flushFrames();
        });
        expect(scene.parent.scrollTop).toBe(900);
        await act(async () => root.unmount());
    });
});

test('unregistering the held section ends the hold', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        const scene = scrollScene();
        await act(async () => api().registerSectionRef('working:src/taxes.ts', scene.node));
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        await act(async () => flushFrames());
        expect(scene.parent.scrollTop).toBe(800);
        await act(async () => api().registerSectionRef('working:src/taxes.ts', null));
        scene.setNodeTop(1000);
        await act(async () => {
            FakeResizeObserver.instances.at(-1)?.emit();
            flushFrames();
        });
        expect(scene.parent.scrollTop).toBe(800);
        await act(async () => root.unmount());
    });
});

test('cancelling a request that still waits for its row leaves the row alone when it registers', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        const scene = scrollScene();
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        await act(async () => api().cancel());
        await act(async () => api().registerSectionRef('working:src/taxes.ts', scene.node));
        await act(async () => flushFrames());
        expect(scene.parent.scrollTop).toBe(0);
        await act(async () => root.unmount());
    });
});

test('cancelling the hold leaves the position where it is', async () => {
    await withDom(async (dom) => {
        const { api, flushFrames, root } = await setup(dom);
        const scene = scrollScene();
        await act(async () => api().registerSectionRef('working:src/taxes.ts', scene.node));
        await act(async () => api().scrollTo('working:src/taxes.ts'));
        await act(async () => flushFrames());
        await act(async () => api().cancel());
        scene.setNodeTop(1200);
        await act(async () => {
            FakeResizeObserver.instances.at(-1)?.emit();
            flushFrames();
        });
        expect(scene.parent.scrollTop).toBe(800);
        await act(async () => root.unmount());
    });
});
