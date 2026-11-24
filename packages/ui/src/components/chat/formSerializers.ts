import type { FormValue } from '@/lib/opencode/model';
import type { FormRequest } from '@/lib/opencode/model';


const RECOMMENDED_MARKER = /\s*\(recommended\)\s*/i;

export const isRecommendedOption = (label: string): boolean => RECOMMENDED_MARKER.test(label);

export const stripRecommendedMarker = (label: string): string => label.replace(RECOMMENDED_MARKER, ' ').trim();

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

export function serializeFormAsJson(form: FormRequest): string {
  return JSON.stringify({ title: form.title, fields: form.fields }, null, 2);
}

export function serializeFormAnswerAsMarkdown(form: FormRequest, answer: Record<string, FormValue>): string {
  const lines: string[] = [];
  const title = form.title.trim();
  if (title) {
    lines.push(`# ${title}`, '');
  }
  for (const field of form.fields) {
    const value = answer[field.key];
    if (value === undefined) continue;
    lines.push(`## ${field.title?.trim() || field.key}`, '');
    const description = field.description?.trim();
    if (description) lines.push(description, '');
    lines.push(`**Answer:** ${Array.isArray(value) ? value.join(', ') : String(value)}`, '');
  }
  lines.push('```json', JSON.stringify(answer), '```');
  return lines.join('\n').trimEnd();
}
