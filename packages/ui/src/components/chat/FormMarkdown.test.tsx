import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { FormMarkdown } from './FormMarkdown';

// The markdown renderer is lazy, so a synchronous server render always emits the
// Suspense fallback FormMarkdown supplies. That fallback is the surface that
// has to keep the exact question text and the question typography classes.
describe('FormMarkdown', () => {
  test('renders the question content verbatim', () => {
    const content = 'Choose **one** from `mode`: [details](https://example.com)';

    const html = renderToStaticMarkup(<FormMarkdown content={content} size="meta" />);

    expect(html).toBe(
      `<div class="form-markdown typography-meta whitespace-pre-wrap">${content}</div>`,
    );
  });

  test('applies meta typography and caller classes', () => {
    const html = renderToStaticMarkup(
      <FormMarkdown content="Meta" size="meta" className="font-medium text-foreground" />,
    );

    expect(html).toContain('class="form-markdown typography-meta font-medium text-foreground whitespace-pre-wrap"');
  });

  test('applies micro typography and caller classes', () => {
    const html = renderToStaticMarkup(
      <FormMarkdown content="Micro" size="micro" className="text-muted-foreground" />,
    );

    expect(html).toContain('class="form-markdown typography-micro text-muted-foreground whitespace-pre-wrap"');
  });
});
