import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { withAttachmentChips } from './attachmentCitationChips';

const render = (text: string, filenames: readonly string[], isOpenable?: (filename: string) => boolean) =>
    renderToStaticMarkup(<>{withAttachmentChips(text, filenames, 'test', isOpenable)}</>);

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

    test('draws plain labels unless the caller opts in, so the composer and the queue get no tab stops', () => {
        const html = render('see [shot.png]', ['shot.png']);

        expect(html).toContain('<span');
        expect(html).not.toContain('<button');
        expect(html).not.toContain('data-attachment-open');
        expect(html).not.toContain('cursor-pointer');
    });

    test('draws a button carrying the file name for each chip the caller can open', () => {
        const html = render('see [shot.png] and [spec.pdf]', ['shot.png', 'spec.pdf'], (filename) => filename === 'shot.png');

        expect(html).toContain('<button type="button"');
        expect(html).toContain('data-attachment-open="shot.png"');
        expect(html).not.toContain('data-attachment-open="spec.pdf"');
        expect(html.match(/<button/g)).toHaveLength(1);
    });
});
