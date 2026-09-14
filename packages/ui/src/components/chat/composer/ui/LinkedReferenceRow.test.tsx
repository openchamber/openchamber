import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { LinkedReferenceRow } from './LinkedReferenceRow';

test('keeps browser access available while pending but blocks replacement and removal', async () => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let reopened = 0;
    let removed = 0;

    try {
        await act(async () => root.render(
            <I18nProvider>
                <LinkedReferenceRow
                    numberLabel="#12"
                    title="Pending issue"
                    url="https://example.test/issues/12"
                    openInBrowserLabel="Open issue"
                    removeLabel="Remove issue"
                    onReopenPicker={() => { reopened += 1; }}
                    onRemove={() => { removed += 1; }}
                    disabled
                />
            </I18nProvider>,
        ));

        const reopen = container.querySelector<HTMLButtonElement>('button');
        const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove issue"]');
        expect(reopen?.disabled).toBe(true);
        expect(remove?.disabled).toBe(true);
        expect(container.querySelector<HTMLAnchorElement>('[aria-label="Open issue"]')?.href).toBe('https://example.test/issues/12');
        await act(async () => { reopen?.click(); remove?.click(); });
        expect({ reopened, removed }).toEqual({ reopened: 0, removed: 0 });
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
});
