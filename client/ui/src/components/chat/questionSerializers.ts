import type { QuestionRequest } from '@/types/question';

/**
 * Pure serializers for QuestionRequest payloads.
 *
 * Extracted from QuestionCard.tsx so they can be unit-tested without
 * pulling the component tree. Living in QuestionCard.tsx triggered the
 * `react-refresh/only-export-components` rule when exposed for tests;
 * the React-free home here avoids that constraint and keeps the
 * QuestionCard import surface focused on rendering.
 */

/**
 * Render a QuestionRequest as Markdown the user can paste into another
 * tool (chat with a companion model, issue tracker, doc, etc.).
 *
 * Layout per question:
 *   ## <header or fallback>
 *
 *   <question body>
 *
 *   _Select all that apply._   (only when q.multiple)
 *
 *   - **<label>** — <description>   (description elided when blank)
 */
export function serializeQuestionAsMarkdown(question: QuestionRequest): string {
  const lines: string[] = [];
  const questions = question.questions ?? [];
  questions.forEach((q, index) => {
    const header = q.header?.trim();
    const title = header && header.length > 0 ? header : `Question ${index + 1}`;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(q.question);
    lines.push('');
    if (q.multiple) {
      lines.push('_Select all that apply._');
      lines.push('');
    }
    q.options.forEach((option) => {
      const label = option.label;
      const description = option.description?.trim();
      lines.push(description ? `- **${label}** — ${description}` : `- **${label}**`);
    });
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/**
 * Render a QuestionRequest as a stable JSON envelope.
 *
 * Mirrors the on-wire `QuestionRequest` shape minus the transient `id`
 * and `sessionID` (which are local routing concerns, not part of the
 * question content). `header` and `description` are normalised to
 * `null` when absent so consumers do not have to distinguish `undefined`
 * from `missing key`.
 */
export function serializeQuestionAsJson(question: QuestionRequest): string {
  const payload = {
    questions: (question.questions ?? []).map((q) => ({
      header: q.header ?? null,
      question: q.question,
      multiple: Boolean(q.multiple),
      options: q.options.map((option) => ({
        label: option.label,
        description: option.description ?? null,
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
