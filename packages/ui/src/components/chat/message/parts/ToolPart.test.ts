import { describe, expect, test } from 'bun:test';

import { getEffectiveToolOutput, renderTerminalOutput } from './toolOutputHelpers';
import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';

describe('getEffectiveToolOutput', () => {
    test('prefers state.output for completed tools', () => {
        expect(getEffectiveToolOutput('bash', 'final output', 'partial output')).toBe('final output');
    });

    test('normalizes completed bash state output while preserving final-output precedence', () => {
        expect(getEffectiveToolOutput('bash', '\u001B[32mFinal output\u001B[0m', 'partial output')).toBe('Final output');
    });

    test('falls back to metadata.output for bash tools without state output', () => {
        expect(getEffectiveToolOutput('bash', undefined, 'partial output')).toBe('partial output');
    });

    test('normalizes bash metadata output for any lifecycle state', () => {
        expect(getEffectiveToolOutput('bash', undefined, 'Progress 10%\r\u001B[2KProgress 90%')).toBe('Progress 90%');
    });

    test('ignores metadata.output for non-bash tools', () => {
        expect(getEffectiveToolOutput('read', undefined, 'partial output')).toBe(undefined);
        expect(getEffectiveToolOutput('read', 'final output', 'partial output')).toBe('final output');
    });

    test('returns undefined when bash has no output', () => {
        expect(getEffectiveToolOutput('bash', undefined, undefined)).toBe(undefined);
    });

    test('ignores empty metadata.output for bash', () => {
        expect(getEffectiveToolOutput('bash', undefined, '')).toBe(undefined);
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
});

describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});
