import { describe, expect, test } from 'bun:test';
import { buildContextSegmentRows } from './segmentRows';

describe('buildContextSegmentRows', () => {
  test('sorts by tokens desc and computes percent of total', () => {
    const rows = buildContextSegmentRows(
      { systemTools: 700, mcpTools: 100, systemPrompt: 50, skills: 100, messages: 50, other: 0, total: 1000 },
      { systemTools: 'System tools', mcpTools: 'MCP tools', systemPrompt: 'System prompt', skills: 'Skills', messages: 'Messages', other: 'Other' },
    );
    expect(rows[0]).toMatchObject({ key: 'systemTools', tokens: 700, percent: 70 });
    expect(rows[1]!.key).toBe('mcpTools');
    expect(rows[rows.length - 1]!.key).toBe('other');
  });

  test('zero total yields zero percents, no NaN', () => {
    const rows = buildContextSegmentRows(
      { systemTools: 0, mcpTools: 0, systemPrompt: 0, skills: 0, messages: 0, other: 0, total: 0 },
      { systemTools: '', mcpTools: '', systemPrompt: '', skills: '', messages: '', other: '' },
    );
    for (const row of rows) expect(row.percent).toBe(0);
  });

  test("'other' segment uses a distinct muted color, real segments use the chart palette", () => {
    const rows = buildContextSegmentRows(
      { systemTools: 700, mcpTools: 100, systemPrompt: 50, skills: 100, messages: 50, other: 10, total: 1010 },
      { systemTools: 'System tools', mcpTools: 'MCP tools', systemPrompt: 'System prompt', skills: 'Skills', messages: 'Messages', other: 'Other' },
    );
    const other = rows.find((row) => row.key === 'other')!;
    const realSegments = rows.filter((row) => row.key !== 'other');
    expect(other.color).toBe('var(--muted-foreground)');
    for (const row of realSegments) {
      expect(row.color).toMatch(/^var\(--chart-\d+\)$/);
      expect(row.color).not.toBe(other.color);
    }
  });
});
