import { describe, expect, test } from 'bun:test';
import { EfficiencyStats } from './EfficiencyStats';

const labels = {
  costPerMillion: 'Cost / 1M tokens',
  costPerSession: 'Cost / session',
  tokensPerSession: 'Tokens / session',
  reasoningShare: 'Reasoning share',
  avgDuration: 'Avg duration',
  medianDuration: 'Median duration',
  longestDuration: 'Longest duration',
};

describe('EfficiencyStats', () => {
  test('renders efficiency KPIs with formatted values', () => {
    const element = EfficiencyStats({
      kpis: {
        costPerMillion: 0.5,
        costPerSession: 1.25,
        tokensPerSession: 100,
        reasoningShare: 0.25,
        avgSessionDurationMs: 60000,
        medianSessionDurationMs: 180000,
        longestSessionDurationMs: 120000,
      },
      labels,
    });
    const json = JSON.stringify(element);
    expect(json).toContain('Cost / 1M tokens');
    expect(json).toContain('Reasoning share');
    expect(json).toContain('Tokens / session');
    expect(json).toContain('25%');
    expect(json).toContain('1m');
    expect(json).toContain('2m');
    expect(json).toContain('3m');
  });

  test('handles zero durations and zero reasoning share without NaN', () => {
    const element = EfficiencyStats({
      kpis: {
        costPerMillion: 0,
        costPerSession: 0,
        tokensPerSession: 0,
        reasoningShare: 0,
        avgSessionDurationMs: 0,
        medianSessionDurationMs: 0,
        longestSessionDurationMs: 0,
      },
      labels,
    });
    const json = JSON.stringify(element);
    expect(json).toContain('0%');
    expect(json).toContain('0m');
    expect(json).not.toContain('NaN');
  });
});
