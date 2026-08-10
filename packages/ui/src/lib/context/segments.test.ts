import { describe, expect, test } from 'bun:test';
import {
  computeContextSegments,
  estimateTokensFromText,
  estimateToolTokens,
  isMcpToolId,
} from './segments';

describe('estimateTokensFromText', () => {
  test('estimates chars/4 rounded up', () => {
    expect(estimateTokensFromText('')).toBe(0);
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('abcde')).toBe(2);
  });
});

describe('estimateToolTokens', () => {
  test('serializes description and parameters', () => {
    const a = estimateToolTokens({ id: 'bash', description: 'Run commands', parameters: { type: 'object' } });
    expect(a).toBeGreaterThan(0);
  });
  test('handles missing fields', () => {
    expect(estimateToolTokens({})).toBe(0);
  });
});

describe('isMcpToolId', () => {
  test('matches configured server name prefixes', () => {
    expect(isMcpToolId('firecrawl.scrape', ['firecrawl'])).toBe(true);
    expect(isMcpToolId('firecrawl_scrape', ['firecrawl'])).toBe(true);
    expect(isMcpToolId('bash', ['firecrawl'])).toBe(false);
  });
});

describe('computeContextSegments', () => {
  const base = {
    inputTokens: 10000,
    messageTokens: { user: 1000, assistant: 2000, tool: 500 },
    systemPromptText: 'x'.repeat(400), // 100 tokens
    tools: [
      { id: 'bash', description: 'y'.repeat(400), parameters: {} },   // ~100 tokens -> builtin
      { id: 'firecrawl.scrape', description: 'z'.repeat(400), parameters: {} }, // MCP
    ],
    mcpServerNames: ['firecrawl'],
    skillsTexts: ['s'.repeat(200)], // 50 tokens
  };

  test('computes all segments and a total floored at inputTokens', () => {
    const seg = computeContextSegments(base);
    expect(seg.messages).toBe(3500);
    expect(seg.systemPrompt).toBe(100);
    expect(seg.mcpTools).toBeGreaterThan(0);
    expect(seg.systemTools).toBeGreaterThan(0);
    expect(seg.skills).toBe(50);
    expect(seg.other).toBe(10000 - (seg.systemTools + seg.mcpTools + seg.systemPrompt + seg.skills + seg.messages));
    expect(seg.total).toBeGreaterThanOrEqual(10000);
  });

  test('other is floored at 0 when estimates exceed inputTokens', () => {
    const seg = computeContextSegments({ ...base, inputTokens: 100 });
    expect(seg.other).toBe(0);
    expect(seg.total).toBe(seg.systemTools + seg.mcpTools + seg.systemPrompt + seg.skills + seg.messages);
  });

  test('empty inputs produce all-zero segments with total >= inputTokens', () => {
    const seg = computeContextSegments({
      inputTokens: 500,
      messageTokens: { user: 0, assistant: 0, tool: 0 },
      systemPromptText: '',
      tools: [],
      mcpServerNames: [],
      skillsTexts: [],
    });
    expect(seg.messages).toBe(0);
    expect(seg.other).toBe(500);
    expect(seg.total).toBe(500);
  });
});
