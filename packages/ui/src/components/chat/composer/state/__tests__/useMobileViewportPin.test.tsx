import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const SCREEN_HEIGHT = 1180;
// The form's bottom edge in normal flow: the bottom of an iPad portrait screen.
const FORM_BOTTOM = SCREEN_HEIGHT;
const KEYBOARD_HEIGHT = 400;

interface Device {
    maxTouchPoints: number;
    standalone: boolean;
}

describe('useMobileViewportPin on the iPad Home Screen app', () => {
    let dom: Window;
    let frames: Array<() => void> = [];
    const viewport = { offsetTop: 0, height: SCREEN_HEIGHT };

    const setup = (device: Device) => {
        dom = new Window({ url: 'http://localhost/' });
        Object.defineProperty(dom.navigator, 'userAgent', { value: IPAD_UA });
        Object.defineProperty(dom.navigator, 'maxTouchPoints', { value: device.maxTouchPoints });
        Object.defineProperty(dom, 'matchMedia', {
            value: (query: string) => ({ matches: device.standalone && query === '(display-mode: standalone)' }),
        });
        Object.defineProperty(dom, 'visualViewport', { value: viewport });
        Object.defineProperty(dom.document.documentElement, 'clientHeight', { value: SCREEN_HEIGHT });
        const requestFrame = (callback: () => void) => frames.push(callback);
        Object.assign(globalThis, {
            window: dom,
            document: dom.document,
            navigator: dom.navigator,
            requestAnimationFrame: requestFrame,
            cancelAnimationFrame: () => {},
            IS_REACT_ACT_ENVIRONMENT: true,
        });
    };

    const flushFrames = () => {
        const pending = frames;
        frames = [];
        pending.forEach((callback) => callback());
    };

    const mountComposer = async (formHeight = 120) => {
        const { createRoot } = await import('react-dom/client');
        const { useMobileViewportPin } = await import('../useMobileViewportPin');

        const formRef = React.createRef<HTMLFormElement>();
        const Composer = () => {
            useMobileViewportPin({
                // An iPad wider than 768px is a tablet surface, not mobile.
                isMobile: false,
                isFullscreen: false,
                isDraftScreen: false,
                isFocused: false,
                formRef,
                editorRef: React.createRef(),
            });
            return (
                <form ref={formRef} style={{ position: 'relative' }}>
                    <textarea />
                </form>
            );
        };

        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        await act(async () => root.render(<Composer />));

        const form = formRef.current;
        if (!form) throw new Error('composer form did not mount');
        // happy-dom has no layout: report the in-flow box, moved by the lift.
        form.getBoundingClientRect = () => {
            const offset = Number.parseFloat(form.style.top || '0');
            return new dom.DOMRect(0, FORM_BOTTOM - formHeight + offset, 820, formHeight);
        };
        const editor = form.querySelector('textarea');
        if (!editor) throw new Error('composer editor did not mount');
        return { form, editor, unmount: () => act(() => root.unmount()) };
    };

    beforeEach(() => {
        frames = [];
        viewport.offsetTop = 0;
        viewport.height = SCREEN_HEIGHT;
    });

    afterEach(() => {
        dom.close();
    });

    test('lifts the composer above the software keyboard as soon as it has focus', async () => {
        setup({ maxTouchPoints: 5, standalone: true });
        const { form, editor, unmount } = await mountComposer();

        // The keyboard is already up, as when it is shown again after a
        // dismissal and no viewport event fires.
        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
        editor.focus();
        flushFrames();
        expect(form.style.top).toBe(`-${KEYBOARD_HEIGHT}px`);

        // Stable once lifted: the next frame measures the same covered part.
        flushFrames();
        expect(form.style.top).toBe(`-${KEYBOARD_HEIGHT}px`);

        editor.blur();
        flushFrames();
        expect(form.style.top).toBe('');
        await unmount();
    });

    test('leaves the composer in place when no keyboard covers it', async () => {
        // A hardware keyboard: focus, but the visible area stays full height.
        setup({ maxTouchPoints: 5, standalone: true });
        const { form, editor, unmount } = await mountComposer();

        editor.focus();
        flushFrames();
        expect(form.style.top).toBe('');
        await unmount();
    });

    test('leaves an expanded composer in place when it cannot fit above the keyboard', async () => {
        setup({ maxTouchPoints: 5, standalone: true });
        // Focus mode: the form fills the chat area below the 50px header.
        const { form, editor, unmount } = await mountComposer(FORM_BOTTOM - 50);

        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
        editor.focus();
        flushFrames();
        expect(form.style.top).toBe('');
        await unmount();
    });

    test('changes nothing in a Safari tab or on a Mac', async () => {
        for (const device of [
            { maxTouchPoints: 5, standalone: false },
            { maxTouchPoints: 0, standalone: true },
        ]) {
            setup(device);
            const { form, editor, unmount } = await mountComposer();

            viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
            editor.focus();
            flushFrames();
            expect(form.style.top).toBe('');
            await unmount();
            dom.close();
            viewport.height = SCREEN_HEIGHT;
        }
        // afterEach closes the last window again; give it a fresh one.
        setup({ maxTouchPoints: 0, standalone: false });
    });
});
