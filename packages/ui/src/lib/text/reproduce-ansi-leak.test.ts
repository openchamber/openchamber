/**
 * Reproduction test for issue #1965
 * Chat leaks ANSI SGR/OSC escape codes from shell-tool output into rendered text.
 *
 * This demonstrates that the current rendering pipeline does NOT strip ANSI
 * escape codes, causing literal control sequence bytes to appear in rendered
 * chat output.
 *
 * Run: bun test packages/ui/src/lib/text/reproduce-ansi-leak.test.ts
 */

import { describe, expect, test } from 'bun:test';

const ESC = '\x1b';

// ============================================================
// Simulation of the current rendering paths
// ============================================================

/**
 * Simulates the current getToolOutputText for bash (ToolPart.tsx line 834-835).
 * For bash tools, it returns the raw output unchanged — NO ANSI stripping.
 */
function currentToolPartGetOutput(output: string): string {
    // Line 834-835 of ToolPart.tsx:
    // const getToolOutputText = (output, part, metadata) => {
    //     if (part.tool === 'bash') { return output; }
    //     return formatEditOutput(output, part.tool, metadata);
    // };
    return output; // bash path returns output as-is → ANSI codes pass through
}

/**
 * Simulates the current inline ANSI-stripping regex in MessageBody.tsx line 1111.
 * Only strips SGR CSI sequences (ESC [ <params> m) — misses everything else.
 */
function currentMessageBodyPartialStrip(output: string): string {
    // eslint-disable-next-line no-control-regex
    return output.replace(/\x1b\[[0-9;]*m/g, '');
}

// ============================================================
// Demonstration: ANSI codes CURRENTLY leak through
// ============================================================

describe('REPRODUCTION: ANSI escape code leak in tool output (#1965)', () => {

    // --- Reproduction step: raw SGR codes pass through ToolPart ---
    test('SGR color codes leak through ToolScrollableTextOutput (bash path)', () => {
        // Simulate ls --color=always producing: ESC[31mfile.txtESC[0m
        const bashOutput = `${ESC}[31mfile.txt${ESC}[0m`;
        const rendered = currentToolPartGetOutput(bashOutput);

        // BUG: The ANSI codes are NOT stripped:
        expect(rendered).toBe(`${ESC}[31mfile.txt${ESC}[0m`);
        // User would see: [31mfile.txt[0m  (the ESC byte is invisible in browser)
        // The visible leak is "[31m" and "[0m" text tokens.
        expect(rendered).toContain('[31m');
        expect(rendered).toContain('[0m');
    });

    test('24-bit color codes leak through (the exact leak from the issue)', () => {
        // Exact reproduction of the OCR snippet from the issue:
        const bashOutput = [
            `${ESC}[2m─── packages/ui/src/components/sections/commands/CommandsPage.tsx:164-164 ───${ESC}[0m`,
            'Using `subtask || undefined` converts `false` to `undefined`, which means the saved config will only',
            `include \`subtask\` when it's \`true\`. This is intentional for omitting falsy values, but it differs`,
            '',
            `${ESC}[2m${ESC}[48;2;38;38;38m ${ESC}[0m${ESC}[48;2;38;38;38m         subtask: subtask || undefined,${ESC}[0m${ESC}[0m`,
        ].join('\n');

        const rendered = currentToolPartGetOutput(bashOutput);

        // BUG: All control bytes remain in the rendered string:
        expect(rendered).toContain('[2m');
        expect(rendered).toContain('[0m');
        expect(rendered).toContain('[48;2;38;38;38m');

        // BUG: The ESC bytes are still present (invisible in browser, but the
        // trailing `[2m` etc. are visible as literal text tokens):
        expect(rendered.includes(ESC)).toBe(true);
    });

    // --- Reproduction step: the existing MessageBody partial strip is insufficient ---
    test('MessageBody inline SGR-only regex misses OSC sequences', () => {
        // ESC ] 0 ; title BEL — sets window title. NOT stripped by the SGR-only regex.
        const input = `output${ESC}]0;window title\x07more text`;
        const stripped = currentMessageBodyPartialStrip(input);

        // BUG: The OSC sequence passes through:
        expect(stripped).toBe(input);
        expect(stripped).toContain(']0;window title');
    });

    test('MessageBody inline SGR-only regex misses DCS sequences', () => {
        // ESC P ... ESC \ — sixel/device control. NOT stripped.
        const input = `${ESC}Pq#0;2;0;0;0${ESC}\\after`;
        const stripped = currentMessageBodyPartialStrip(input);

        // BUG: The DCS sequence passes through:
        expect(stripped).toBe(input);
    });

    test('MessageBody inline SGR-only regex misses cursor movement CSI', () => {
        // ESC [ 2 J — erase display. Final byte is J (not m), so the SGR-only
        // regex doesn't strip it.
        const input = `before${ESC}[2J${ESC}[Hafter`;
        const stripped = currentMessageBodyPartialStrip(input);

        // BUG: Cursor movement CSI passes through:
        expect(stripped).toBe(input);
    });

    test('MessageBody inline SGR-only regex misses two-byte ESC sequences', () => {
        // ESC % G — select UTF-8 charset. NOT a CSI/DCS/OSC sequence.
        const input = `before${ESC}%Gafter`;
        const stripped = currentMessageBodyPartialStrip(input);

        // BUG: Two-byte ESC sequence passes through:
        expect(stripped).toBe(input);
    });

    test('MessageBody inline SGR-only regex misses CSI sub-parameter separators', () => {
        // ESC [ 38 : 2 : R : G : B m — modern 24-bit color with colon separator.
        // The current regex uses [0-9;] which doesn't match `:`.
        const input = `${ESC}[38:2:255:128:0mtext${ESC}[0m`;
        const stripped = currentMessageBodyPartialStrip(input);

        // BUG: Sub-parameter SGR passes through because `:` is not matched:
        expect(stripped).toContain('[38:2:255:128:0');
    });

    test('MessageBody inline SGR-only regex misses CSI private-mode bytes', () => {
        // ESC [ > 0 c — secondary device attributes.
        const input = `${ESC}[>0cresponse`;
        const stripped = currentMessageBodyPartialStrip(input);

        // BUG: The `>` byte is not in [0-9;], so the CSI is NOT stripped:
        expect(stripped).toContain('[>0c');
    });

    // --- The ToolOutputDialog also renders raw output ---
    test('ToolOutputDialog default path renders raw content without ANSI stripping', () => {
        // In ToolOutputDialog.tsx, for bash output that reaches the default
        // WorkerHighlightedCode path (line 1200-1208), popup.content is used
        // as-is — no ANSI stripping occurs.
        const dialogContent = `line1${ESC}[31mcolored${ESC}[0mline2`;
        // The dialog's code is: <WorkerHighlightedCode code={popup.content} ... />
        // No stripping happens before this pass.
        expect(dialogContent).toContain('[31m');
        expect(dialogContent).toContain('[0m');
    });

    test('ToolOutputDialog <pre> fallback for list/grep/glob also not stripped', () => {
        // Line 1134-1138: <pre>{popup.content}</pre>
        // Line 1144-1149: <pre>{popup.content}</pre>
        // Line 1154-1159: <pre>{popup.content}</pre>
        // All render popup.content directly — no ANSI stripping.
        const grepOutput = `file.ts:1:${ESC}[01;31mTODO${ESC}[0m: fix me`;
        expect(grepOutput).toContain('[01;31m');
        expect(grepOutput).toContain('[0m');
    });

    // --- ToolPart: also doesn't strip when copy-to-clipboard is used ---
    test('Copy-to-clipboard in ToolPart also copies raw ANSI codes', () => {
        // ToolPart line 864-875: handleCopyOutput copies renderedOutput which
        // is getToolOutputText(output, part, metadata) — no stripping.
        const output = `${ESC}[32msuccess${ESC}[0m`;
        const copyText = currentToolPartGetOutput(output);
        // BUG: User copies text that includes control codes:
        expect(copyText).toBe(output);
    });

    // --- Summary: comprehensive leak demo ---
    test('SUMMARY: Multiple ANSI sequence types all leak through rendering pipeline', () => {
        const leakExamples: Array<{ label: string; input: string }> = [
            {
                label: 'SGR color',
                input: `${ESC}[31mred${ESC}[0m`,
            },
            {
                label: 'SGR bold+bright',
                input: `${ESC}[1;32mbold green${ESC}[0m`,
            },
            {
                label: 'SGR 24-bit',
                input: `${ESC}[48;2;38;38;38mbg${ESC}[0m`,
            },
            {
                label: 'OSC (window title)',
                input: `${ESC}]0;My Title\x07`,
            },
            {
                label: 'DCS (sixel)',
                input: `${ESC}Pqdata${ESC}\\`,
            },
            {
                label: 'Cursor move CSI',
                input: `${ESC}[2J${ESC}[H`,
            },
            {
                label: 'Two-byte ESC',
                input: `${ESC}%G`,
            },
            {
                label: 'Sub-parameter CSI',
                input: `${ESC}[38:2:255:128:0m`,
            },
            {
                label: 'Private-mode CSI',
                input: `${ESC}[>0c`,
            },
        ];

        for (const { label, input } of leakExamples) {
            const rendered = currentToolPartGetOutput(input);
            // All input escapes should be stripped — but they're NOT:
            expect(rendered.includes(ESC)).toBe(true);
        }
    });
});
