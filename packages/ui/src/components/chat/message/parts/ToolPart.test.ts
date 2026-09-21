import { describe, expect, test } from 'bun:test';

import { getStreamingOutputAppend, getToolOutput, renderTerminalOutput } from './toolOutput';
import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import { parseDiffToUnified, tryParseJsonOutput } from '../toolRenderers';
import { getStreamingThrottleText } from '../../hooks/useStreamingTextThrottle';
import { getToolDescriptionFallback } from './toolRenderUtils';

describe('getToolOutput', () => {
    test('prefers state.output for completed tools', () => {
        expect(getToolOutput('bash', 'final output', 'partial output', 'completed')).toBe('final output');
    });

    test('normalizes completed bash state output while preserving final-output precedence', () => {
        expect(getToolOutput('bash', '\u001B[32mFinal output\u001B[0m', 'partial output', 'completed')).toBe('Final output');
    });

    test('falls back to metadata.output for bash tools without state output', () => {
        expect(getToolOutput('bash', undefined, 'partial output', 'completed')).toBe('partial output');
    });

    test('normalizes bash metadata output for completed state', () => {
        expect(getToolOutput('bash', undefined, 'Progress 10%\r\u001B[2KProgress 90%', 'completed')).toBe('Progress 90%');
    });

    test('does not normalize bash output while running', () => {
        expect(getToolOutput('bash', '\u001B[32mRunning\u001B[0m', undefined, 'running')).toBe('\u001B[32mRunning\u001B[0m');
        expect(getToolOutput('bash', undefined, 'Progress\r\u001B[2K', 'running')).toBe('Progress\r\u001B[2K');
    });

    test('ignores metadata.output for non-bash tools', () => {
        expect(getToolOutput('read', undefined, 'partial output', 'completed')).toBe(undefined);
        expect(getToolOutput('read', 'final output', 'partial output', 'completed')).toBe('final output');
    });

    test('returns undefined when bash has no output', () => {
        expect(getToolOutput('bash', undefined, undefined, 'completed')).toBe(undefined);
    });

    test('ignores empty metadata.output for bash', () => {
        expect(getToolOutput('bash', undefined, '', 'completed')).toBe(undefined);
    });
});

describe('parseDiffToUnified', () => {
    test('handles a streamed diff with a bare Index header', () => {
        expect(parseDiffToUnified('Index:')).toEqual([]);
        expect(parseDiffToUnified('Index:\n@@ -1,1 +1,1 @@\n-old\n+new')).toEqual([
            {
                file: 'file',
                oldStart: 1,
                newStart: 1,
                lines: [
                    { type: 'removed', lineNumber: 1, content: 'old' },
                    { type: 'added', lineNumber: 1, content: 'new' },
                ],
            },
        ]);
    });

    test('preserves spaces when extracting the indexed filename', () => {
        const [hunk] = parseDiffToUnified('Index: src/my file.ts\n@@ -1,1 +1,1 @@\n-old\n+new');

        expect(hunk?.file).toBe('my file.ts');
    });
});

describe('renderTerminalOutput', () => {
    test('renders carriage-return progress updates as their latest value', () => {
        expect(renderTerminalOutput('Downloading 10%\r\u001B[2KDownloading 90%')).toBe('Downloading 90%');
    });

    test('removes ANSI styles while preserving the output text', () => {
        expect(renderTerminalOutput('\u001B[32mComplete\u001B[0m\n')).toBe('Complete\n');
    });

    test('applies cursor-up progress updates to the prior line', () => {
        expect(renderTerminalOutput('First\nWorking\u001B[1A\r\u001B[2KDone\n')).toBe('Done\nWorking');
    });

    test('CSI K erases from cursor to end of line', () => {
        expect(renderTerminalOutput('Hello World\u001B[5G\u001B[K')).toBe('Hell');
    });

    test('CSI 1 K erases from beginning of line through cursor, preserving suffix', () => {
        expect(renderTerminalOutput('Hello World\u001B[6G\u001B[1K')).toBe('      World');
    });

    test('CSI 2 K erases entire line', () => {
        expect(renderTerminalOutput('Hello World\u001B[2K')).toBe('');
    });

    test('handles large single-line output without quadratic slowdown', () => {
        const largeLine = 'A'.repeat(50000) + '\u001B[0m';
        const start = performance.now();
        const result = renderTerminalOutput(largeLine);
        const elapsed = performance.now() - start;
        expect(result).toBe('A'.repeat(50000));
        expect(elapsed).toBeLessThan(1000);
    });

    test('bounds synthetic rows from large cursor coordinates', () => {
        const result = renderTerminalOutput('\u001B[999999999Bdone');
        expect(result.endsWith('done')).toBe(true);
        expect(result.length <= 100_004).toBe(true);
    });

    test('bounds synthetic columns from large cursor coordinates', () => {
        const result = renderTerminalOutput('\u001B[999999999Cdone');
        expect(result.endsWith('done')).toBe(true);
        expect(result.length <= 100_004).toBe(true);
    });

    test('shares the synthetic allocation budget across cursor movements', () => {
        const result = renderTerminalOutput('\u001B[50001B\u001B[999999999Cdone');
        expect(result.endsWith('done')).toBe(true);
        expect(result.length <= 100_004).toBe(true);
    });

    test('bounds absolute cursor row and column coordinates', () => {
        const result = renderTerminalOutput('\u001B[999999999;999999999Hdone');
        expect(result.endsWith('done')).toBe(true);
        expect(result.length <= 100_004).toBe(true);
    });

    test('bounds absolute cursor columns', () => {
        const result = renderTerminalOutput('\u001B[999999999Gdone');
        expect(result.endsWith('done')).toBe(true);
        expect(result.length <= 100_004).toBe(true);
    });
});

describe('getStreamingOutputAppend', () => {
    test('returns only newly appended output', () => {
        expect(getStreamingOutputAppend('first\n', 'first\nsecond\n')).toBe('second\n');
    });

    test('requires replacement when output is rewritten or shortened', () => {
        expect(getStreamingOutputAppend('progress 10%', 'progress 20%')).toBe(undefined);
        expect(getStreamingOutputAppend('long output', 'short')).toBe(undefined);
    });
});

describe('streaming output transitions', () => {
    test('allows bash snapshots to be rewritten or shortened while running', () => {
        expect(getStreamingThrottleText('progress 10%', 'progress 20%', true, true)).toBe('progress 20%');
        expect(getStreamingThrottleText('long output', 'short', true, true)).toBe('short');
    });

    test('preserves monotonic streaming text by default', () => {
        expect(getStreamingThrottleText('long output', 'short', true, false)).toBe('long output');
    });
});

describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});

describe('OpenChamber tool output', () => {
    test('keeps the result envelope in the generic JSON rendering pipeline', () => {
        const result = {
            schemaVersion: 1,
            ok: true,
            action: 'projects.list',
            data: { projects: [] },
        };
        expect(tryParseJsonOutput(JSON.stringify(result))).toEqual({ data: result, isJson: true });
    });
});

describe('getToolDescriptionFallback', () => {
    test('uses the glob pattern when the provided description and title are empty', () => {
        expect(getToolDescriptionFallback('glob', '', { pattern: 'packages/electron/README.md' }))
            .toBe('packages/electron/README.md');
    });

    test('prefers an existing glob description over the pattern', () => {
        expect(getToolDescriptionFallback('glob', 'Electron docs', { pattern: 'packages/electron/README.md' }))
            .toBe('Electron docs');
    });
});
