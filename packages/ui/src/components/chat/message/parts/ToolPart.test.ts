import { describe, expect, test } from 'bun:test';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import { tryParseJsonOutput } from '../toolRenderers';
import { getStreamingThrottleText } from '../../hooks/useStreamingTextThrottle';
import { getStreamingOutputAppend, getToolOutput } from './toolOutput';
import { getToolDescriptionFallback } from './toolRenderUtils';

describe('getToolOutput', () => {
    test('prefers authoritative state output', () => {
        expect(getToolOutput('bash', 'final output', 'streamed output')).toBe('final output');
        expect(getToolOutput('bash', '', 'streamed output')).toBe('');
    });

    test('falls back to streamed metadata output for bash', () => {
        expect(getToolOutput('bash', undefined, 'streamed output')).toBe('streamed output');
        expect(getToolOutput('bash', undefined, '')).toBe(undefined);
    });

    test('does not expose metadata output for other tools', () => {
        expect(getToolOutput('read', undefined, 'metadata output')).toBe(undefined);
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
