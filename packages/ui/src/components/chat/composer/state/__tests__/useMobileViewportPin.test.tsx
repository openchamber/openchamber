import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const SCREEN_HEIGHT = 1180;
// The form's bottom edge in normal flow: the bottom of an iPad portrait screen.
const FORM_BOTTOM = SCREEN_HEIGHT;
const KEYBOARD_HEIGHT = 400;
const IDLE_CHECK_MS = 250;

interface Device {
    maxTouchPoints: number;
    standalone: boolean;
}

// The visual viewport as Safari reports it; tests move the keyboard by
// changing these numbers, with or without the event Safari may skip.
class FakeViewport extends EventTarget {
    offsetTop = 0;
    height = SCREEN_HEIGHT;
}

// An iPad wider than 768px is a tablet surface, not mobile.
const TABLET_SURFACE = { isMobile: false, isDraftScreen: false, isFocused: false };

describe('useMobileViewportPin', () => {
    let dom: Window;
    let frames = new Map<number, (now: number) => void>();
    let nextFrame = 1;
    let checks = new Map<number, () => void>();
    let nextCheck = 1;
    let now = 0;
    let viewport = new FakeViewport();

    const setup = (device: Device) => {
        dom = new Window({ url: 'http://localhost/' });
        Object.defineProperty(dom.navigator, 'userAgent', { value: IPAD_UA });
        Object.defineProperty(dom.navigator, 'maxTouchPoints', { value: device.maxTouchPoints });
        Object.defineProperty(dom, 'matchMedia', {
            value: (query: string) => ({ matches: device.standalone && query === '(display-mode: standalone)' }),
        });
        Object.defineProperty(dom, 'visualViewport', { value: viewport });
        Object.defineProperty(dom.document.documentElement, 'clientHeight', { value: SCREEN_HEIGHT });
        Object.assign(dom, {
            setTimeout: (callback: () => void) => {
                checks.set(nextCheck, callback);
                return nextCheck++;
            },
            clearTimeout: (id: number) => checks.delete(id),
        });
        Object.assign(globalThis, {
            window: dom,
            document: dom.document,
            navigator: dom.navigator,
            requestAnimationFrame: (callback: (now: number) => void) => {
                frames.set(nextFrame, callback);
                return nextFrame++;
            },
            cancelAnimationFrame: (id: number) => frames.delete(id),
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            },
            IS_REACT_ACT_ENVIRONMENT: true,
        });
    };

    const flushFrames = () => {
        now += 16;
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(now));
    };

    /** Run frames for `ms` of still time. */
    const holdStill = (ms: number) => {
        const end = now + ms;
        while (now < end && frames.size > 0) flushFrames();
    };

    /** Let the idle check's timer run. */
    const runCheck = () => {
        now += IDLE_CHECK_MS;
        const pending = [...checks.values()];
        checks.clear();
        pending.forEach((callback) => callback());
    };

    const mountComposer = async (formHeight = 120, surface = TABLET_SURFACE) => {
        const { createRoot } = await import('react-dom/client');
        const { useMobileViewportPin } = await import('../useMobileViewportPin');

        const formRef = React.createRef<HTMLFormElement>();
        const Composer = () => {
            useMobileViewportPin({
                ...surface,
                isFullscreen: false,
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
        Object.defineProperty(form, 'offsetHeight', { get: () => formHeight });
        const editor = form.querySelector('textarea');
        if (!editor) throw new Error('composer editor did not mount');
        return { form, editor, unmount: () => act(() => root.unmount()) };
    };

    beforeEach(() => {
        frames = new Map();
        checks = new Map();
        now = 0;
        viewport = new FakeViewport();
        spyOn(performance, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
        mock.restore();
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

    test('stops measuring every frame once the keyboard holds still, and still follows a silent move', async () => {
        setup({ maxTouchPoints: 5, standalone: true });
        const { form, editor, unmount } = await mountComposer();

        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
        editor.focus();
        holdStill(2000);
        expect(form.style.top).toBe(`-${KEYBOARD_HEIGHT}px`);
        expect(frames.size).toBe(0);
        expect(checks.size).toBe(1);

        // A check that finds nothing moved goes back to waiting.
        runCheck();
        expect(frames.size).toBe(0);
        expect(checks.size).toBe(1);

        // A taller keyboard (emoji, predictions) arrives without an event.
        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT - 50;
        runCheck();
        expect(form.style.top).toBe(`-${KEYBOARD_HEIGHT + 50}px`);
        // Back to frames while the keyboard may still be moving.
        expect(frames.size).toBe(1);

        await unmount();
        expect(frames.size).toBe(0);
        expect(checks.size).toBe(0);
    });

    test('a tap on the composer brings the frames back at once', async () => {
        setup({ maxTouchPoints: 5, standalone: true });
        const { form, editor, unmount } = await mountComposer();

        editor.focus();
        holdStill(2000);
        expect(frames.size).toBe(0);
        expect(checks.size).toBe(1);

        // The dismissed keyboard comes back on a tap, with no viewport event.
        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
        editor.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
        expect(form.style.top).toBe(`-${KEYBOARD_HEIGHT}px`);
        expect(frames.size).toBe(1);
        expect(checks.size).toBe(0);
        await unmount();
    });

    test('clears the lift and schedules nothing once focus leaves the iPad composer', async () => {
        setup({ maxTouchPoints: 5, standalone: true });
        const { form, editor, unmount } = await mountComposer();

        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
        editor.focus();
        holdStill(2000);
        expect(form.style.top).toBe(`-${KEYBOARD_HEIGHT}px`);

        editor.blur();
        runCheck();
        expect(form.style.top).toBe('');
        expect(frames.size).toBe(0);
        expect(checks.size).toBe(0);
        await unmount();
    });

    test('measures nothing on the iPad while the composer has no focus', async () => {
        setup({ maxTouchPoints: 5, standalone: true });
        const { unmount } = await mountComposer();

        viewport.dispatchEvent(new Event('resize'));
        expect(frames.size).toBe(0);
        expect(checks.size).toBe(0);
        await unmount();
    });

    test('settles the phone draft screen pin the same way', async () => {
        setup({ maxTouchPoints: 5, standalone: false });
        const { form, unmount } = await mountComposer(120, {
            isMobile: true,
            isDraftScreen: true,
            isFocused: true,
        });

        viewport.height = SCREEN_HEIGHT - KEYBOARD_HEIGHT;
        holdStill(2000);
        expect(form.style.top).toBe(`${SCREEN_HEIGHT - KEYBOARD_HEIGHT - 120}px`);
        expect(frames.size).toBe(0);

        // Safari pans the visual viewport without telling anyone.
        viewport.offsetTop = 30;
        runCheck();
        expect(form.style.top).toBe(`${SCREEN_HEIGHT - KEYBOARD_HEIGHT - 120 + 30}px`);
        expect(frames.size).toBe(1);
        await unmount();
    });
});
