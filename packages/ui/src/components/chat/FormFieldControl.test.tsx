import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window();
Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { FormFieldControl } = await import('./FormFieldControl');
const { fieldAnswer, initialFormValues, valueOf } = await import('./formCardState');
import type { FormField } from '@opencode/client';

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

afterEach(async () => {
    await act(() => root.unmount());
    root = createRoot(container);
});

// happy-dom has no layout. Model a border-box textarea: scrollHeight includes
// padding and is at least clientHeight, but excludes the two 1px borders.
// This is the browser contract the old sizing effect fed back into itself.
function installGeometry(textarea: HTMLTextAreaElement) {
    let reads = 0;
    Object.defineProperties(textarea, {
        offsetHeight: { get: () => Math.max(10, Number.parseFloat(textarea.style.height) || 0) },
        clientHeight: { get: () => Math.max(8, textarea.offsetHeight - 2) },
        scrollHeight: { configurable: true, get: () => {
            reads += 1;
            return Math.max(textarea.clientHeight, textarea.value.split('\n').length * 20 + 8);
        } },
    });
    return () => reads;
}

async function enterText(textarea: HTMLTextAreaElement, text: string) {
    await act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function mountField(custom: boolean) {
    const field = {
        key: 'answer', type: 'string', title: 'Answer',
        custom,
        options: custom ? [{ label: 'Preset', value: 'preset' }] : undefined,
    } satisfies FormField;
    function Form() {
        const [values, setValues] = React.useState(() => initialFormValues([field]));
        return <I18nProvider><FormFieldControl
            field={field} values={values} missing={[]} showErrors={false} isResponding={false}
            updateValue={(key, patch) => setValues((previous) => ({ ...previous, [key]: { ...valueOf(previous, key), ...patch } }))}
            onTextKeyDown={() => {}}
        /><output>{fieldAnswer(field, values)}</output></I18nProvider>;
    }
    await act(() => root.render(<Form />));
    if (custom) {
        const other = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Other'));
        if (!other) throw new Error('Custom answer option missing');
        await act(() => other.click());
    }
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Answer textarea missing');
    return textarea;
}

describe('form answer textarea sizing', () => {
    for (const custom of [false, true]) {
        test(`long answer can be cleared and typed again (${custom ? 'custom' : 'plain'})`, async () => {
            const textarea = await mountField(custom);
            const readCount = installGeometry(textarea);
            await enterText(textarea, 'Long answer\n'.repeat(20));
            expect(textarea.style.height).toBe('200px');
            expect(textarea.style.overflowY).toBe('auto');
            const beforeDeletion = readCount();

            await enterText(textarea, '');

            expect(container.contains(textarea)).toBe(true);
            expect(textarea.value).toBe('');
            expect(textarea.style.height).toBe('40px');
            expect(textarea.style.overflowY).toBe('hidden');
            expect(readCount() - beforeDeletion).toBeLessThan(5);
            await enterText(textarea, 'A revised answer');
            expect(textarea.value).toBe('A revised answer');
            expect(container.querySelector('output')?.textContent).toBe('A revised answer');
        });
    }

    test('measuring an edit at the cap preserves the scrolling parent', async () => {
        const textarea = await mountField(false);
        installGeometry(textarea);
        const parent = textarea.parentElement;
        if (!parent) throw new Error('Field wrapper missing');
        parent.style.minHeight = '12px';
        Object.defineProperty(parent, 'offsetHeight', {
            get: () => Math.max(textarea.offsetHeight + 24, Number.parseFloat(parent.style.minHeight) || 0),
        });
        const scrollHeight = Object.getOwnPropertyDescriptor(textarea, 'scrollHeight')?.get;
        Object.defineProperty(textarea, 'scrollHeight', { get: () => {
            // A layout read clamps a short scrolling parent's offset when its
            // content temporarily collapses. Reserving the wrapper prevents it.
            parent.scrollTop = Math.min(parent.scrollTop, Math.max(0, parent.offsetHeight - 120));
            return scrollHeight?.call(textarea);
        } });
        await enterText(textarea, 'Long answer\n'.repeat(20));
        parent.scrollTop = 104;
        await enterText(textarea, `${textarea.value}x`);
        expect(parent.scrollTop).toBe(104);
        expect(parent.style.minHeight).toBe('12px');
        await enterText(textarea, 'Short answer');
        expect(textarea.style.height).toBe('40px');
        expect(parent.style.minHeight).toBe('12px');
    });
});
