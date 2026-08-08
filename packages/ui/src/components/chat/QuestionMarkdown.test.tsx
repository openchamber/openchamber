import { describe, expect, test } from 'bun:test';

import { SimpleMarkdownRenderer } from './MarkdownRenderer';
import { QuestionMarkdown } from './QuestionMarkdown';

describe('QuestionMarkdown', () => {
  test('delegates exact content to the tool markdown renderer', () => {
    const content = 'Choose **one** from `mode`: [details](https://example.com)';
    const element = QuestionMarkdown({ content, size: 'meta' });

    expect(element.type).toBe(SimpleMarkdownRenderer);
    expect(element.props.content).toBe(content);
    expect(element.props.variant).toBe('tool');
    expect(element.props.fallbackContent.props.children).toBe(content);
    expect(element.props.fallbackContent.props.className).toContain('whitespace-pre-wrap');
  });

  test('preserves question typography size and caller classes', () => {
    const meta = QuestionMarkdown({ content: 'Meta', size: 'meta', className: 'font-medium text-foreground' });
    const micro = QuestionMarkdown({ content: 'Micro', size: 'micro', className: 'text-muted-foreground' });

    expect(meta.props.className).toBe('question-markdown typography-meta font-medium text-foreground');
    expect(micro.props.className).toBe('question-markdown typography-micro text-muted-foreground');
  });
});
