import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { decorateMarkdown } from '../markdown/decorate';
import { cloneMessageImageExportSource, MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE } from './imageExport';

Object.assign(globalThis, { document: new Window().document });

describe('message image export', () => {
    test('marks external-link favicons as export-only decoration', () => {
        const source = document.createElement('div');
        source.innerHTML = '<p><a href="https://example.com/docs">Documentation</a></p>';

        decorateMarkdown(source, {
            labels: {
                copy: 'Copy',
                copied: 'Copied',
                enableCodeWrap: 'Wrap',
                disableCodeWrap: 'Do not wrap',
                copyTable: 'Copy table',
                downloadTable: 'Download table',
                copyDiagram: 'Copy diagram',
                downloadDiagram: 'Download diagram',
                zoomInDiagram: 'Zoom in',
                zoomOutDiagram: 'Zoom out',
                resetDiagramView: 'Reset',
                previewLabel: 'Preview',
                previewTitle: 'Preview',
            },
            mermaidControls: { download: false, copy: false, showPanZoomControls: false },
            codeBlockLineWrap: false,
            renderMermaid: () => ({}),
        });

        const favicon = source.querySelector(`span[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"] > img`);
        expect(favicon?.getAttribute('src')).toBe('https://icons.duckduckgo.com/ip3/example.com.ico');
    });

    test('omits marked decoration from the clone without removing content or mutating the source', () => {
        const source = document.createElement('div');
        source.innerHTML = `
            <span ${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true">
                <img src="https://icons.duckduckgo.com/ip3/example.com.ico" alt="">
            </span>
            <p>Message content</p>
            <img src="data:image/png;base64,content" alt="Message image">
        `;

        const clone = cloneMessageImageExportSource(source);

        expect(Boolean(clone.querySelector(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"]`))).toBe(false);
        expect(Boolean(clone.querySelector('img[src^="https://icons.duckduckgo.com/"]'))).toBe(false);
        expect(clone.textContent).toContain('Message content');
        expect(Boolean(clone.querySelector('img[alt="Message image"]'))).toBe(true);
        expect(Boolean(source.querySelector(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"]`))).toBe(true);
    });
});
