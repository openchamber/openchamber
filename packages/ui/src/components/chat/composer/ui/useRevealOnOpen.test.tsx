import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { useRevealOnOpen } from './useRevealOnOpen';

const Field: React.FC<{ open: boolean; tick: number; onReveal: () => void }> = ({ open, onReveal }) => {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        if (ref.current) ref.current.scrollIntoView = onReveal;
    }, [onReveal]);
    useRevealOnOpen(ref, open);
    return <div ref={ref} />;
};

describe('useRevealOnOpen', () => {
    test('a composing field is scrolled into view once, then the scroll is the user\'s', async () => {
        const win = new Window({ url: 'http://localhost' });
        for (const [key, value] of Object.entries({ window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })) {
            Object.defineProperty(globalThis, key, { configurable: true, value });
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let reveals = 0;
        const onReveal = () => { reveals += 1; };

        await act(async () => root.render(<Field open={false} tick={0} onReveal={onReveal} />));
        expect(reveals).toBe(0);
        await act(async () => root.render(<Field open tick={0} onReveal={onReveal} />));
        expect(reveals).toBe(1);
        await act(async () => root.render(<Field open tick={1} onReveal={onReveal} />));
        await act(async () => root.render(<Field open={false} tick={2} onReveal={onReveal} />));
        await act(async () => root.render(<Field open tick={3} onReveal={onReveal} />));
        expect(reveals).toBe(1);

        await act(async () => root.unmount());
    });
});
