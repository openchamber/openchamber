import { describe, expect, test } from 'bun:test';
import type { FormRequest } from '@/lib/opencode/model';
import { buildFormAnswer, initialFormValues, type FormValues } from './formCardState';
import {
  isRecommendedOption,
  serializeFormAnswerAsMarkdown,
  serializeFormAsJson,
  serializeFormAsMarkdown,
  stripRecommendedMarker,
} from './formSerializers';

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

describe('answer serializer for recovered questions', () => {
  const answerForm: FormRequest = {
    id: 'form_2',
    sessionID: 'ses_1',
    title: 'Plan the work',
    fields: [
      { key: 'days', type: 'number', title: 'How many days?', required: true },
      { key: 'ship', type: 'boolean', title: 'Ship it?' },
      { key: 'areas', type: 'multiselect', title: 'Areas', custom: true, options: [{ value: 'ui', label: 'UI' }] },
      { key: 'color', type: 'string', title: 'Color', custom: true, options: [{ value: 'red', label: 'Red' }] },
      {
        key: 'detail',
        type: 'string',
        title: 'Only when shipping',
        when: [{ key: 'ship', op: 'eq', value: true }],
      },
    ],
  };

  const answered: FormValues = {
    ...initialFormValues(answerForm.fields),
    days: { text: '', number: 3, boolean: false, selected: [], custom: false, acknowledged: false },
    ship: { text: '', number: null, boolean: true, selected: [], custom: false, acknowledged: false },
    areas: { text: 'docs', number: null, boolean: false, selected: ['ui'], custom: true, acknowledged: false },
    color: { text: 'teal', number: null, boolean: false, selected: [], custom: true, acknowledged: false },
    detail: { text: 'typed but hidden', number: null, boolean: false, selected: [], custom: false, acknowledged: false },
  };

  test('carries the question context and the answer payload', () => {
    const text = serializeFormAnswerAsMarkdown(answerForm, buildFormAnswer(answerForm.fields, answered));
    expect(text).toBe([
      '# Plan the work',
      '',
      '## How many days?',
      '',
      '**Answer:** 3',
      '',
      '## Ship it?',
      '',
      '**Answer:** true',
      '',
      '## Areas',
      '',
      '**Answer:** ui, docs',
      '',
      '## Color',
      '',
      '**Answer:** teal',
      '',
      '## Only when shipping',
      '',
      '**Answer:** typed but hidden',
      '',
      '```json',
      '{"days":3,"ship":true,"areas":["ui","docs"],"color":"teal","detail":"typed but hidden"}',
      '```',
    ].join('\n'));
  });

  test('omits a field its when-clause hid', () => {
    const hidden: FormValues = {
      ...answered,
      ship: { text: '', number: null, boolean: false, selected: [], custom: false, acknowledged: false },
    };
    const text = serializeFormAnswerAsMarkdown(answerForm, buildFormAnswer(answerForm.fields, hidden));
    expect(text).not.toContain('Only when shipping');
    expect(text).not.toContain('typed but hidden');
    expect(text).toContain('{"days":3,"ship":false,"areas":["ui","docs"],"color":"teal"}');
  });
});
