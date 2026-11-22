import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useAvatarImage } from './useAvatarImage';

let dom: Window;
let root: Root;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Avatar: React.FC<{ url?: string | null }> = ({ url }) => {
    const { broken, onError } = useAvatarImage(url);
    return url && !broken ? <img src={url} alt="" onError={onError} /> : <span>A</span>;
};

beforeEach(() => {
    dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    host = document.createElement('div');
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    dom.close();
    for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test('a failed image shows the initial until its URL changes', async () => {
    await act(async () => root.render(<Avatar url="/first.png" />));
    const image = host.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/first.png');

    await act(async () => { image!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('A');

    await act(async () => root.render(<Avatar url="/first.png" />));
    expect(host.querySelector('img')).toBeNull();

    await act(async () => root.render(<Avatar url="/second.png" />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/second.png');
    expect(host.textContent).toBe('');
});

test('clearing the URL allows the same image to be tried again', async () => {
    await act(async () => root.render(<Avatar url="/avatar.png" />));
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    await act(async () => root.render(<Avatar url={null} />));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('A');

    await act(async () => root.render(<Avatar url="/avatar.png" />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/avatar.png');
});
