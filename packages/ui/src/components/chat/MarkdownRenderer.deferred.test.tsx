import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownRenderer, SimpleMarkdownRenderer } from './MarkdownRenderer';
import { MarkdownHydrationProvider } from './markdown/MarkdownHydrationProvider';

describe('deferred Markdown rendering', () => {
    test('shows a skeleton while keeping raw source visually hidden', () => {
        const markup = renderToStaticMarkup(
            <MarkdownHydrationProvider enabled={false}>
                <MarkdownRenderer
                    content={'# Latest\n<script>alert("no")</script>'}
                    messageId="message-1"
                    isAnimated={false}
                />
            </MarkdownHydrationProvider>,
        );

        expect(markup).toContain('data-markdown-hydration="deferred"');
        expect(markup).toContain('data-markdown-placeholder="skeleton"');
        expect(markup).toContain('data-markdown-size-spacer="true"');
        expect(markup).toContain('class="invisible block whitespace-pre-wrap"');
        expect(markup).toContain('&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;');
        expect(markup).not.toContain('data-markdown-content');
    });

    test('also defers simple Markdown used by historical user and tool content', () => {
        const markup = renderToStaticMarkup(
            <MarkdownHydrationProvider enabled={false}>
                <SimpleMarkdownRenderer content="**deferred**" variant="tool" />
            </MarkdownHydrationProvider>,
        );

        expect(markup).toContain('data-markdown-hydration="deferred"');
        expect(markup).toContain('data-markdown-placeholder="skeleton"');
        expect(markup).toContain('**deferred**');
    });

    test('caps animated skeleton structure for very large Markdown', () => {
        const content = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
        const markup = renderToStaticMarkup(
            <MarkdownHydrationProvider enabled={false}>
                <MarkdownRenderer content={content} messageId="message-large" isAnimated={false} />
            </MarkdownHydrationProvider>,
        );

        expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(5);
        expect(markup).not.toContain('motion-safe:animate-pulse');
        expect(markup.match(/animate-none/g)?.length).toBe(5);
    });
});
