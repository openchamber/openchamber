import type { ContextSegments } from './segments';

export type ContextSegmentKey = 'systemTools' | 'mcpTools' | 'systemPrompt' | 'skills' | 'messages' | 'other';

export interface ContextSegmentRow {
  key: ContextSegmentKey;
  label: string;
  tokens: number;
  percent: number;
  color: string;
}

const CONTEXT_SEGMENT_COLORS: Record<ContextSegmentKey, string> = {
  systemTools: 'var(--chart-1)',
  messages: 'var(--chart-2)',
  systemPrompt: 'var(--chart-3)',
  skills: 'var(--chart-4)',
  mcpTools: 'var(--chart-5)',
  other: 'var(--muted-foreground)',
};

export function buildContextSegmentRows(
  segments: ContextSegments,
  labels: Record<ContextSegmentKey, string>,
): ContextSegmentRow[] {
  const order: readonly ContextSegmentKey[] = ['systemTools', 'mcpTools', 'systemPrompt', 'skills', 'messages', 'other'];
  const total = segments.total > 0 ? segments.total : 0;
  return order
    .map((key) => ({
      key,
      label: labels[key],
      tokens: segments[key],
      percent: total > 0 ? Math.round((segments[key] / total) * 1000) / 10 : 0,
      color: CONTEXT_SEGMENT_COLORS[key],
    }))
    .sort((a, b) => b.tokens - a.tokens);
}
