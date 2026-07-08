import { describe, expect, test } from 'bun:test';

import { getMermaidDataUrlSourcePromise } from './toolOutputDialogMermaid';

describe('getMermaidDataUrlSourcePromise', () => {
    test('turns malformed data URLs into rejected promises', async () => {
        const sourcePromise = getMermaidDataUrlSourcePromise('data:text/plain;base64');

        await sourcePromise.then(
            () => {
                throw new Error('expected malformed data URL to reject');
            },
            (error) => expect(error).toEqual({ key: 'chat.toolOutputDialog.mermaid.dataUrlMalformed', params: undefined }),
        );
    });
});
