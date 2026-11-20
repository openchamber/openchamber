import { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData, ToolState } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';

const { default: ToolPart } = await import('./ToolPart');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
    currentTheme: theme,
    availableThemes: [theme],
    setTheme: unexpectedThemeChange,
    customThemesLoading: false,
    reloadCustomThemes: unexpectedThemeChange,
    importTheme: unexpectedThemeChange,
    deleteImportedTheme: unexpectedThemeChange,
    customThemeIds: [],
    isSystemPreference: false,
    setSystemPreference: unexpectedThemeChange,
    themeMode: 'light',
    setThemeMode: unexpectedThemeChange,
    lightThemeId: theme.metadata.id,
    darkThemeId: getDefaultTheme(true).metadata.id,
    setLightThemePreference: unexpectedThemeChange,
    setDarkThemePreference: unexpectedThemeChange,
};

// An overwrite reports real deletions, the case where the result diff is the
// only truthful source; the input preview can only ever show additions.
const overwritePatch = '--- a/src/notes.md\n+++ b/src/notes.md\n@@ -1,3 +1,3 @@\n-alpha\n+alpha revised\n beta\n gamma';

test('a write row draws one diff: the reported one, not the input preview', async () => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const globals = {
        window: happyWindow,
        Window: happyWindow.Window,
        Event: happyWindow.Event,
        CustomEvent: happyWindow.CustomEvent,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        localStorage: happyWindow.localStorage,
        customElements: happyWindow.customElements,
        Node: happyWindow.Node,
        Text: happyWindow.Text,
        NodeList: happyWindow.NodeList,
        Element: happyWindow.Element,
        HTMLElement: happyWindow.HTMLElement,
        SVGElement: happyWindow.SVGElement,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
        ResizeObserver: happyWindow.ResizeObserver,
        MutationObserver: happyWindow.MutationObserver,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const sdk = OpenCode.make({
        baseUrl: 'http://localhost',
        fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
    });

    const writePart = (state: ToolState): ToolPartData => ({
        id: 'write', sessionID: 'session', messageID: 'message', type: 'tool',
        tool: 'write', callID: 'write', state,
    });
    const input = { filePath: 'src/notes.md', content: 'alpha revised\nbeta\ngamma' };
    const render = async (state: ToolState) => {
        await act(async () => root.render(
            <SyncProvider sdk={sdk} directory="">
                <I18nProvider>
                    <ThemeSystemContext.Provider value={themeContext}>
                        <ToolPart part={writePart(state)} isExpanded isMobile={false} onToggle={() => {}} />
                    </ThemeSystemContext.Provider>
                </I18nProvider>
            </SyncProvider>,
        ));
        return {
            // The input preview is the only block wrapped in this surface.
            inputPreview: container.querySelectorAll('.tool-input-surface'),
            // One set of entry actions per reported diff entry.
            reportedEntries: container.querySelectorAll('button[aria-label="Open file at first change"]'),
        };
    };

    try {
        useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });

        const completed = await render({
            status: 'completed',
            input,
            metadata: { files: [{ relativePath: 'src/notes.md', patch: overwritePatch }] },
            output: 'Wrote src/notes.md',
            time: { start: 1, end: 2 },
        });
        expect(completed.inputPreview).toHaveLength(0);
        expect(completed.reportedEntries).toHaveLength(1);

        // A native write reports no diff of its own: the preview still stands in.
        const native = await render({
            status: 'completed',
            input,
            metadata: {},
            output: 'Wrote src/notes.md',
            time: { start: 1, end: 2 },
        });
        expect(native.inputPreview).toHaveLength(1);
        expect(native.reportedEntries).toHaveLength(0);

        // Metadata with no usable patch draws nothing in its place: the preview stays.
        const unusable = await render({
            status: 'completed',
            input,
            metadata: { diff: 'the tool could not compute a diff' },
            output: 'Wrote src/notes.md',
            time: { start: 1, end: 2 },
        });
        expect(unusable.inputPreview).toHaveLength(1);

        // A long diagnostic is no patch, however long: the preview stays.
        const longDiagnostic = await render({
            status: 'completed',
            input,
            metadata: { diff: Array.from({ length: 2_100 }, (_, index) => `diagnostic line ${index}`).join('\n') },
            output: 'Wrote src/notes.md',
            time: { start: 1, end: 2 },
        });
        expect(longDiagnostic.inputPreview).toHaveLength(1);

        // A hunk header past the visible cutoff does not count either.
        const lateHunk = await render({
            status: 'completed',
            input,
            metadata: { diff: [...Array.from({ length: 2_100 }, (_, index) => `diagnostic line ${index}`), '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n') },
            output: 'Wrote src/notes.md',
            time: { start: 1, end: 2 },
        });
        expect(lateHunk.inputPreview).toHaveLength(1);

        // While the call runs there is no result yet, so the preview is all there is.
        const running = await render({ status: 'running', input, time: { start: 1 } });
        expect(running.inputPreview).toHaveLength(1);
        expect(running.reportedEntries).toHaveLength(0);
    } finally {
        await act(async () => { root.unmount(); });
        await happyWindow.happyDOM.abort();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});
