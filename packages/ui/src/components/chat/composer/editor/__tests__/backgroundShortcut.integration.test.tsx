import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { ComposerEditorHandle } from '../ComposerEditor';
import type { ComposerLanguageContext } from '../../language/tokenize';

// Oracle: CodeMirror's keymap contract. The composer's intercept runs at the
// highest precedence, and when it reports a press as handled CodeMirror runs
// no lower keymap, so the macOS emacs Ctrl-b (caret one character left,
// asserted present below) never runs. happy-dom has no layout, so the caret
// itself cannot move here; the test observes what the editor was told and
// what reached the window instead. CodeMirror reads the platform when it
// loads, so the macOS navigator is installed before the editor is imported.

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const languageContext: ComposerLanguageContext = {
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
    knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
};
const overrides = { background_session_work: 'ctrl+b' };

describe('a background shortcut rebound to Ctrl+B in the macOS composer', () => {
    const browser = new Window({ settings: { navigator: { userAgent: MAC_UA } } });
    // CodeMirror tells macOS by `navigator.platform`, OpenChamber by the user agent.
    Object.defineProperty(browser.navigator, 'platform', { value: 'MacIntel', configurable: true });
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    let root: Root;

    beforeAll(async () => {
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            KeyboardEvent: browser.KeyboardEvent,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        for (const [name, value] of Object.entries(globals)) {
            descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
    });

    afterAll(() => {
        browser.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    const press = async (backgroundHandles: boolean) => {
        // Imported here, after beforeAll installed the macOS globals.
        const { ComposerEditor } = await import('../ComposerEditor');
        const { takeComposerApplicationShortcut } = await import('../applicationShortcuts');
        const shortcuts = await import('@/lib/shortcuts');
        const { ShortcutRegistry } = await import('@/lib/shortcuts/registry');
        const { createRoot } = await import('react-dom/client');
        const registry = new ShortcutRegistry();
        const calls: string[] = [];
        let editorConsumed: boolean | undefined;
        let windowSaw = 0;
        // The Cmd+B sidebar default also matches Ctrl+B in a macOS browser.
        registry.register('toggle_sidebar', () => { calls.push('sidebar'); });
        registry.register('background_session_work', () => {
            if (!backgroundHandles) return false;
            calls.push('background');
        });
        // The app's window route, as useKeyboardShortcuts installs it.
        const dispatcher = new shortcuts.ShortcutDispatcher({
            registry,
            getBinding: (actionId) => shortcuts.getEffectiveShortcutCombo(actionId, overrides),
        });
        const onWindowKeyDown = (event: KeyboardEvent) => {
            windowSaw += 1;
            if (dispatcher.dispatch(event)) event.preventDefault();
        };
        window.addEventListener('keydown', onWindowKeyDown);

        const editor = React.createRef<ComposerEditorHandle>();
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(
            <ComposerEditor ref={editor} value="abc" placeholder="Build or ask"
                languageContext={languageContext} onChange={() => {}}
                onKeyDown={(event) => {
                    takeComposerApplicationShortcut(event, overrides, registry);
                    editorConsumed = event.defaultPrevented;
                    return editorConsumed;
                }} />,
        ));
        await act(async () => {
            editor.current?.focus();
            editor.current?.setSelection(3);
        });
        const content = document.querySelector('.cm-content');
        if (!content) throw new Error('Composer not mounted');
        await act(async () => {
            content.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true,
            }));
        });
        await act(async () => root.unmount());
        host.remove();
        window.removeEventListener('keydown', onWindowKeyDown);
        return { calls, editorConsumed, windowSaw };
    };

    test('the macOS editor keymap binds Ctrl-b, so the collision is real', async () => {
        const { standardKeymap } = await import('@codemirror/commands');
        expect(standardKeymap.some((binding) => binding.mac === 'Ctrl-b')).toBe(true);
    });

    test('moves the work to the background once and keeps the press from the editor keymap', async () => {
        const { calls, editorConsumed, windowSaw } = await press(true);
        expect(calls).toEqual(['background']);
        expect(editorConsumed).toBe(true);
        // Stopped in the composer: the window route cannot run it a second time.
        expect(windowSaw).toBe(0);
    });

    test('leaves Ctrl+B to the editor when there is nothing to move', async () => {
        const { calls, editorConsumed, windowSaw } = await press(false);
        expect(calls).not.toContain('background');
        expect(editorConsumed).toBe(false);
        expect(windowSaw).toBe(1);
    });
});
