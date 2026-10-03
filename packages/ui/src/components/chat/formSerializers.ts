import type { FormRequest } from '@/lib/opencode/model';

/**
 * Pure serializers for a form request, so the user can carry an agent's
 * question into another tool (a companion model, an issue, a doc).
 * React-free so they can be unit-tested without the card.
 */

const RECOMMENDED_MARKER = /\s*\(recommended\)\s*/i;

/** Whether an option label carries the agent's "(recommended)" marker. */
export const isRecommendedOption = (label: string): boolean => RECOMMENDED_MARKER.test(label);

/** The option label without the "(recommended)" marker; the card shows a badge instead. */
export const stripRecommendedMarker = (label: string): string => label.replace(RECOMMENDED_MARKER, ' ').trim();

/**
 * Markdown, one section per field:
 *
 *   ## <title or key>
 *
 *   <description>
 *
 *   _Select all that apply._        (multiselect only)
 *
 *   - **<label>** — <description>   (options; description elided when blank)
 */
export function serializeFormAsMarkdown(form: FormRequest): string {
  const lines: string[] = [];
  const title = form.title.trim();
  if (title) {
    lines.push(`# ${title}`, '');
  }
  for (const field of form.fields) {
    lines.push(`## ${field.title?.trim() || field.key}`, '');
    const description = field.description?.trim();
    if (description) lines.push(description, '');
    if (field.type === 'external') {
      lines.push(`<${field.url}>`, '');
      continue;
    }
    if (field.type === 'multiselect') lines.push('_Select all that apply._', '');
    const options = field.type === 'multiselect' || field.type === 'string' ? field.options ?? [] : [];
    for (const option of options) {
      const optionDescription = option.description?.trim();
      lines.push(optionDescription ? `- **${option.label}** — ${optionDescription}` : `- **${option.label}**`);
    }
    if (options.length > 0) lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * A stable JSON envelope of the form's content: the transient `id` and
 * `sessionID` are local routing concerns and stay out.
 */
export function serializeFormAsJson(form: FormRequest): string {
  return JSON.stringify({ title: form.title, fields: form.fields }, null, 2);
}
