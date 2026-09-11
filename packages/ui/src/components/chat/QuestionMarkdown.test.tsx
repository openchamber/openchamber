import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuestionMarkdown } from './QuestionMarkdown';

// The markdown renderer is lazy, so a synchronous server render always emits the
// Suspense fallback QuestionMarkdown supplies. That fallback is the surface that
// has to keep the exact question text and the question typography classes.
describe('QuestionMarkdown', () => {
  test('renders the question content verbatim', () => {
    const content = 'Choose **one** from `mode`: [details](https://example.com)';

    const html = renderToStaticMarkup(<QuestionMarkdown content={content} size="meta" />);

    expect(html).toBe(
      `<div class="question-markdown typography-meta whitespace-pre-wrap">${content}</div>`,
    );
  });

  test('applies meta typography and caller classes', () => {
    const html = renderToStaticMarkup(
      <QuestionMarkdown content="Meta" size="meta" className="font-medium text-foreground" />,
    );

    expect(html).toContain('class="question-markdown typography-meta font-medium text-foreground whitespace-pre-wrap"');
  });

  test('applies micro typography and caller classes', () => {
    const html = renderToStaticMarkup(
      <QuestionMarkdown content="Micro" size="micro" className="text-muted-foreground" />,
    );

    expect(html).toContain('class="question-markdown typography-micro text-muted-foreground whitespace-pre-wrap"');
  });
});
