import { afterEach, describe, expect, test } from 'bun:test';

import { copyTextToClipboard } from '@/lib/clipboard';
import { getShellBridgeAssistantDetails } from './shellBridge';
import { getShellClipboardText, renderTerminalOutput } from '../message/parts/toolOutput';

// Reproduction for https://github.com/openchamber/openchamber/issues/2876
//
// [Bug] Pasting from the copy button in the shell widget to the terminal fails
//
// The shell widget (UserShellActionPart in MessageBody.tsx) keeps the raw
// `state.output` of a user-executed bash tool for display. Its copy handler uses
// `getShellClipboardText` before calling `copyTextToClipboard`, matching the
// terminal-output normalization used by the tool part renderer. Raw bash tool
// output routinely contains carriage returns, erase-line and style sequences
// (spinner/progress output).
//
// When the copied text is pasted into the integrated terminal (a VT emulator),
// those control sequences are interpreted as terminal commands instead of being
// pasted literally. The user sees only the "final frame" of the output, often a
// single character.

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
    if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
        Reflect.deleteProperty(globalThis, 'navigator');
    }
});

// Realistic raw bash tool output as captured for a user-executed command with a
// spinner/progress sequence (same shape as the project's own tool-output test
// fixtures, e.g. `'Progress 10%\r\u001B[2KProgress 90%'`).
const RAW_SPINNER_OUTPUT = '\r\u001B[2K\r\u2839 Installing dependencies...\r\u001B[2K\r\u2713\u001B[0m\n';

describe('issue 2876: shell widget copy -> integrated terminal paste', () => {
    test('the shell bridge exposes raw bash output to the widget', () => {
        const assistantMessage = {
            info: { id: 'assistant-1', role: 'assistant', parentID: 'user-1' },
            parts: [
                {
                    type: 'tool',
                    tool: 'bash',
                    state: {
                        status: 'completed',
                        input: { command: 'pnpm install' },
                        output: RAW_SPINNER_OUTPUT,
                    },
                },
            ],
        };

        // SAFETY: This fixture intentionally supplies only the runtime message
        // fields inspected by getShellBridgeAssistantDetails.
        const { hide, details } = getShellBridgeAssistantDetails(assistantMessage as never, 'user-1');

        expect(hide).toBe(true);
        // The output handed to the widget remains the raw terminal stream:
        // carriage returns, ESC [ 2 K erase-line and color sequences are intact.
        expect(details?.output).toBe(RAW_SPINNER_OUTPUT);
        expect(details?.output).toContain('\r');
        expect(details?.output).toContain('\u001B[2K');
    });

    test('the widget copy handler puts the NORMALIZED visible text on the clipboard (fix)', async () => {
        let written: string | undefined;
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                clipboard: {
                    writeText: async (text: string) => {
                        written = text;
                    },
                },
            },
        });

        // UserShellActionPart.copyOutputToClipboard passes the raw stream
        // through the shared helper before writing the VT-interpreted text.
        const result = await copyTextToClipboard(getShellClipboardText(RAW_SPINNER_OUTPUT));

        expect(result.ok).toBe(true);
        expect(written).toBe('\u2713\n');
        expect(written).not.toContain('\r');
        expect(written).not.toContain('\u001B');
    });

    test('pasting the normalized clipboard content into the integrated terminal is clean (fix)', () => {
        // Content on the clipboard after pressing the shell widget copy button
        // (post-fix): the normalized visible text, no control sequences.
        const clipboardText = getShellClipboardText(RAW_SPINNER_OUTPUT);

        // The integrated terminal is a VT emulator: pasted bytes are fed to the
        // shell and interpreted exactly like typed input. `renderTerminalOutput`
        // is the project's own VT interpretation model for bash output.
        const visibleAfterPaste = renderTerminalOutput(clipboardText);

        // No \r / ESC [ 2 K sequences remain, so nothing is erased: the full
        // visible output survives the paste instead of collapsing to one char.
        expect(visibleAfterPaste).toBe('\u2713\n');
    });

    test('progress-style output pastes truncated to its last frame (raw, pre-fix)', () => {
        // Matches the existing raw-output fixture shape in ToolPart.test.ts.
        // This documents what the RAW stream would do if it reached the
        // clipboard; the copy handler now normalizes before writing.
        const clipboardText = 'Progress 10%\r\u001B[2KProgress 90%';

        const visibleAfterPaste = renderTerminalOutput(clipboardText);

        expect(visibleAfterPaste).toBe('Progress 90%');
    });

    test('control-sequence-free text (terminal selection copy) pastes cleanly', () => {
        // Copying via the terminal's own selection (Cmd+C / right-click copy)
        // produces visible screen text without control sequences.
        const clipboardText = 'pnpm install\n';

        expect(renderTerminalOutput(clipboardText)).toBe(clipboardText);
    });
});
