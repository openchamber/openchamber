import { describe, test, expect } from 'bun:test';
import { serializeQuestionAsJson, serializeQuestionAsMarkdown } from '../questionSerializers';
import type { QuestionRequest, QuestionInfo, QuestionOption } from '@/types/question';

function makeOption(label: string, description = ''): QuestionOption {
  return { label, description };
}

function makeQuestion(overrides: Partial<QuestionInfo> & { question: string }): QuestionInfo {
  return {
    header: '',
    options: [],
    ...overrides,
  };
}

function makeRequest(questions: QuestionInfo[]): QuestionRequest {
  return {
    id: 'req-test',
    sessionID: 'sess-test',
    questions,
  };
}

describe('serializeQuestionAsMarkdown', () => {
  test('renders header, body and labelled options', () => {
    const md = serializeQuestionAsMarkdown(
      makeRequest([
        makeQuestion({
          header: 'Pick mode',
          question: 'Which mode should we use?',
          options: [makeOption('safe', 'Default'), makeOption('aggressive')],
        }),
      ])
    );
    expect(md.startsWith('## Pick mode')).toBe(true);
    expect(md.includes('Which mode should we use?')).toBe(true);
    expect(md.includes('- **safe** — Default')).toBe(true);
    expect(md.includes('- **aggressive**')).toBe(true);
    expect(md.includes(' — ')).toBe(true);
  });

  test('falls back to "Question N" when header is empty or whitespace', () => {
    const md = serializeQuestionAsMarkdown(
      makeRequest([
        makeQuestion({ header: '   ', question: 'A?', options: [makeOption('yes')] }),
        makeQuestion({ header: '', question: 'B?', options: [makeOption('yes')] }),
      ])
    );
    expect(md.includes('## Question 1')).toBe(true);
    expect(md.includes('## Question 2')).toBe(true);
  });

  test('emits multi-select hint only when q.multiple is true', () => {
    const single = serializeQuestionAsMarkdown(
      makeRequest([makeQuestion({ question: 'pick', options: [makeOption('a')] })])
    );
    const multi = serializeQuestionAsMarkdown(
      makeRequest([makeQuestion({ question: 'pick', multiple: true, options: [makeOption('a')] })])
    );
    expect(single.includes('_Select all that apply._')).toBe(false);
    expect(multi.includes('_Select all that apply._')).toBe(true);
  });

  test('elides description when it is blank or whitespace', () => {
    const md = serializeQuestionAsMarkdown(
      makeRequest([
        makeQuestion({
          question: 'q?',
          options: [makeOption('x', '   '), makeOption('y', '')],
        }),
      ])
    );
    expect(md.includes('- **x**\n')).toBe(true);
    expect(md.includes('- **y**')).toBe(true);
    expect(md.includes(' — ')).toBe(false);
  });

  test('serializes multiple questions in order', () => {
    const md = serializeQuestionAsMarkdown(
      makeRequest([
        makeQuestion({ header: 'First', question: 'one?', options: [makeOption('a')] }),
        makeQuestion({ header: 'Second', question: 'two?', options: [makeOption('b')] }),
      ])
    );
    const firstIdx = md.indexOf('## First');
    const secondIdx = md.indexOf('## Second');
    expect(firstIdx >= 0).toBe(true);
    expect(secondIdx > firstIdx).toBe(true);
  });

  test('returns trimmed output (no trailing blank line)', () => {
    const md = serializeQuestionAsMarkdown(
      makeRequest([makeQuestion({ question: 'q?', options: [makeOption('a')] })])
    );
    expect(md.endsWith('\n')).toBe(false);
    expect(md.endsWith('- **a**')).toBe(true);
  });

  test('handles empty questions array', () => {
    const md = serializeQuestionAsMarkdown(makeRequest([]));
    expect(md).toBe('');
  });

  test('handles question with zero options', () => {
    const md = serializeQuestionAsMarkdown(
      makeRequest([makeQuestion({ header: 'Empty', question: 'free?', options: [] })])
    );
    expect(md.includes('## Empty')).toBe(true);
    expect(md.includes('free?')).toBe(true);
  });
});

describe('serializeQuestionAsJson', () => {
  test('produces canonical envelope preserving description strings', () => {
    const json = serializeQuestionAsJson(
      makeRequest([
        makeQuestion({
          header: 'Pick',
          question: 'pick?',
          options: [makeOption('a', 'A desc'), makeOption('b')],
        }),
      ])
    );
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      questions: [
        {
          header: 'Pick',
          question: 'pick?',
          multiple: false,
          options: [
            { label: 'a', description: 'A desc' },
            { label: 'b', description: '' },
          ],
        },
      ],
    });
  });

  test('preserves empty-string header as the literal empty string', () => {
    // empty string is truthy enough to keep; only undefined/missing becomes null
    const json = serializeQuestionAsJson(
      makeRequest([makeQuestion({ header: '', question: 'q?', options: [makeOption('x')] })])
    );
    const parsed = JSON.parse(json);
    expect(parsed.questions[0].header).toBe('');
  });

  test('reflects q.multiple as Boolean true when set, false when absent', () => {
    const json = serializeQuestionAsJson(
      makeRequest([
        makeQuestion({ question: 'q1', multiple: true, options: [makeOption('a')] }),
        makeQuestion({ question: 'q2', options: [makeOption('a')] }),
      ])
    );
    const parsed = JSON.parse(json);
    expect(parsed.questions[0].multiple).toBe(true);
    expect(parsed.questions[1].multiple).toBe(false);
  });

  test('omits transient request id and sessionID', () => {
    const json = serializeQuestionAsJson(
      makeRequest([makeQuestion({ question: 'q?', options: [makeOption('a')] })])
    );
    expect(json.includes('req-test')).toBe(false);
    expect(json.includes('sess-test')).toBe(false);
  });

  test('uses 2-space indentation (human-pasteable)', () => {
    const json = serializeQuestionAsJson(
      makeRequest([makeQuestion({ question: 'q?', options: [makeOption('a')] })])
    );
    expect(json.includes('\n  "questions"')).toBe(true);
    expect(json.includes('\n    {')).toBe(true);
  });

  test('handles empty questions array', () => {
    const json = serializeQuestionAsJson(makeRequest([]));
    expect(JSON.parse(json)).toEqual({ questions: [] });
  });

  test('handles undefined description option from runtime payload', () => {
    const json = serializeQuestionAsJson(
      makeRequest([
        makeQuestion({
          question: 'q?',
          options: [{ label: 'x' } as unknown as QuestionOption],
        }),
      ])
    );
    const parsed = JSON.parse(json);
    expect(parsed.questions[0].options[0]).toEqual({ label: 'x', description: null });
  });
});
