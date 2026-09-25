import { describe, expect, test } from 'bun:test';
import type { FormRequest } from '@/lib/opencode/model';
import { isRecommendedOption, serializeFormAsJson, serializeFormAsMarkdown, stripRecommendedMarker } from './formSerializers';

const form: FormRequest = {
  id: 'form_1',
  sessionID: 'ses_1',
  title: 'Pick a strategy',
  fields: [
    {
      key: 'approach',
      type: 'string',
      title: 'Approach',
      description: 'How should the refactor proceed?',
      options: [
        { value: 'a', label: 'Incremental (recommended)', description: 'Small steps' },
        { value: 'b', label: 'Big bang' },
      ],
    },
    { key: 'areas', type: 'multiselect', options: [{ value: 'ui', label: 'UI' }] },
    { key: 'docs', type: 'external', url: 'https://example.test/doc', title: 'Read first' },
  ],
};

describe('form serializers', () => {
  test('markdown lists every field with its options', () => {
    expect(serializeFormAsMarkdown(form)).toBe([
      '# Pick a strategy',
      '',
      '## Approach',
      '',
      'How should the refactor proceed?',
      '',
      '- **Incremental (recommended)** — Small steps',
      '- **Big bang**',
      '',
      '## areas',
      '',
      '_Select all that apply._',
      '',
      '- **UI**',
      '',
      '## Read first',
      '',
      '<https://example.test/doc>',
    ].join('\n'));
  });

  test('json keeps the content and drops the routing ids', () => {
    // SAFETY: the serializer wrote exactly `{ title, fields }`; the test reads back what it wrote.
    const parsed = JSON.parse(serializeFormAsJson(form)) as { title: string; fields: unknown[]; id?: string };
    expect(parsed.title).toBe('Pick a strategy');
    expect(parsed.fields).toHaveLength(3);
    expect(parsed.id).toBeUndefined();
  });

  test('the recommended marker becomes a badge, not label text', () => {
    expect(isRecommendedOption('Incremental (recommended)')).toBe(true);
    expect(isRecommendedOption('Big bang')).toBe(false);
    expect(stripRecommendedMarker('Incremental (recommended)')).toBe('Incremental');
  });
});
