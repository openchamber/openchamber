import { describe, expect, test } from 'bun:test';

import { parseVisionRunOutput } from './visionToolModel';

describe('parseVisionRunOutput', () => {
    test('extracts the description payload from a successful envelope', () => {
        const { data, error } = parseVisionRunOutput(JSON.stringify({
            schemaVersion: 1,
            ok: true,
            action: 'vision.run',
            data: {
                description: 'A dashboard with two charts.',
                model: 'anthropic/claude-sonnet-4',
                imagePath: '/work/shot.png',
                imageFilename: 'shot.png',
                imageMime: 'image/png',
                imageSize: 1234,
            },
        }));

        expect(error).toBeNull();
        expect(data).toEqual({
            description: 'A dashboard with two charts.',
            model: 'anthropic/claude-sonnet-4',
            imagePath: '/work/shot.png',
            imageFilename: 'shot.png',
            imageMime: 'image/png',
            imageSize: 1234,
        });
    });

    test('extracts the error message from a failed envelope', () => {
        const { data, error } = parseVisionRunOutput(JSON.stringify({
            schemaVersion: 1,
            ok: false,
            action: 'vision.run',
            error: { message: 'No vision model configured', kind: 'usage' },
        }));

        expect(data).toBeNull();
        expect(error).toBe('No vision model configured');
    });

    test('ignores a failed envelope without an error message', () => {
        const { data, error } = parseVisionRunOutput(JSON.stringify({
            schemaVersion: 1,
            ok: false,
            action: 'vision.run',
            error: { kind: 'runtime' },
        }));

        expect(data).toBeNull();
        expect(error).toBeNull();
    });

    test('returns nothing for empty or unparseable output', () => {
        expect(parseVisionRunOutput('')).toEqual({ data: null, error: null });
        expect(parseVisionRunOutput('not json at all')).toEqual({ data: null, error: null });
        expect(parseVisionRunOutput(JSON.stringify([1, 2, 3]))).toEqual({ data: null, error: null });
    });

    test('treats a data-less successful envelope as nothing', () => {
        expect(parseVisionRunOutput(JSON.stringify({ schemaVersion: 1, ok: true, action: 'vision.run' })))
            .toEqual({ data: null, error: null });
    });
});
