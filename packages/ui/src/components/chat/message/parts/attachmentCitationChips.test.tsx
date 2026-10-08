import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { withAttachmentChips } from './attachmentCitationChips';

const render = (text: string, filenames: readonly string[]) =>
    renderToStaticMarkup(<>{withAttachmentChips(text, filenames, 'test')}</>);

describe('withAttachmentChips', () => {
    test('draws citations of known files as chips and leaves other brackets as text', () => {
        const html = render('see [shot.png] and [notes]', ['shot.png']);

        expect(html).toContain('title="shot.png"');
        expect(html).toContain('[notes]');
        expect(html).not.toContain('[shot.png]');
    });

    test('returns the text untouched when nothing is attached', () => {
        expect(withAttachmentChips('see [shot.png]', [], 'test')).toEqual(['see [shot.png]']);
    });
});
