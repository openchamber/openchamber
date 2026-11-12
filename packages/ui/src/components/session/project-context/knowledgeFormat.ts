import { getCurrentIntlLocale } from '@/lib/i18n';

/**
 * A note has no title field; its first non-empty line is the title, the same
 * way agents and people already write them. Markdown heading and emphasis
 * markers are dropped from the title so `# Release` reads as "Release".
 */
export const splitNoteTitle = (body: string) => {
  const lines = body.split('\n');
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex === -1) {
    return { title: '', rest: '' };
  }
  const title = lines[titleIndex]
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim();
  const rest = lines.slice(titleIndex + 1).join('\n').trim();
  return { title, rest };
};

const isSameDay = (left: Date, right: Date): boolean => (
  left.getFullYear() === right.getFullYear()
  && left.getMonth() === right.getMonth()
  && left.getDate() === right.getDate()
);

/** Time for today's entries, a short date otherwise; the year only when it differs. */
export const formatKnowledgeDate = (timestamp: number, now: Date = new Date()): string => {
  const date = new Date(timestamp);
  const locale = getCurrentIntlLocale();
  if (isSameDay(date, now)) {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, date.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
};
