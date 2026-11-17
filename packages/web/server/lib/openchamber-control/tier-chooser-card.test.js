import { describe, expect, it } from 'vitest';

import {
  buildQuotaFallbackCard,
  buildTierChooserCard,
  escapeHtml,
} from './tier-chooser-card.js';

// Entities in data-* attributes decode back to the raw value in the DOM, so
// decode them here before JSON-parsing a pinned payload.
const decodeEntities = (value) => String(value ?? '')
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/&amp;/g, '&');

const payloads = (html) => [...html.matchAll(/data-payload="([^"]*)"/g)]
  .map((match) => JSON.parse(decodeEntities(match[1])));

const summaries = (html) => [...html.matchAll(/data-summary="([^"]*)"/g)]
  .map((match) => decodeEntities(match[1]));

const tiers = () => ([
  { tier: 'cheap', model: 'anthropic/claude-haiku', inputPerM: '0.25', outputPerM: '1.25', latency: 'fast' },
  { tier: 'standard', model: 'openai/gpt-4o', inputPerM: '2.50', outputPerM: '10.00', latency: 'balanced' },
  { tier: 'frontier', model: 'anthropic/claude-sonnet', inputPerM: '3.00', outputPerM: '15.00', latency: 'deep reasoning' },
]);

const fallbackActions = () => ([
  { kind: 'switch-provider', label: 'Switch provider (Frontier)', provider: 'openai', tier: 'frontier' },
  { kind: 'downgrade-tier', label: 'Downgrade to Standard', provider: 'anthropic', tier: 'standard' },
  { kind: 'wait-for-reset', label: 'Wait for window reset', provider: 'anthropic', tier: 'frontier' },
]);

describe('tier chooser card', () => {
  it('builds one tile per tier, each submitting { tier, model } via openchamber.submit', () => {
    const html = buildTierChooserCard({ tiers: tiers() });

    expect(html).toContain('Select Execution Tier');
    expect(html).toContain('openchamber.submit');
    expect(payloads(html)).toEqual([
      { tier: 'cheap', model: 'anthropic/claude-haiku' },
      { tier: 'standard', model: 'openai/gpt-4o' },
      { tier: 'frontier', model: 'anthropic/claude-sonnet' },
    ]);
    expect(summaries(html)).toEqual([
      'Selected Cheap Tier (anthropic/claude-haiku)',
      'Selected Standard Tier (openai/gpt-4o)',
      'Selected Frontier Tier (anthropic/claude-sonnet)',
    ]);
    for (const tier of ['cheap', 'standard', 'frontier']) {
      expect(html).toContain(`data-tier="${tier}"`);
    }
  });

  it('renders caller-supplied models.dev pricing per tile', () => {
    const html = buildTierChooserCard({ tiers: tiers() });

    expect(html).toContain('$0.25 in / $1.25 out per 1M');
    expect(html).toContain('$2.50 in / $10.00 out per 1M');
    expect(html).toContain('$3.00 in / $15.00 out per 1M');
  });
});

describe('quota fallback card', () => {
  it('builds the three fallback actions submitting { action: fallback, provider, tier }', () => {
    const html = buildQuotaFallbackCard({
      message: 'Anthropic quota exceeded',
      currentProvider: 'anthropic',
      currentTier: 'frontier',
      actions: fallbackActions(),
    });

    expect(html).toContain('Quota Limit Reached');
    expect(html).toContain('Anthropic quota exceeded');
    expect(html).toContain('openchamber.submit');
    for (const kind of ['switch-provider', 'downgrade-tier', 'wait-for-reset']) {
      expect(html).toContain(`data-kind="${kind}"`);
    }
    expect(payloads(html)).toEqual([
      { action: 'fallback', provider: 'openai', tier: 'frontier' },
      { action: 'fallback', provider: 'anthropic', tier: 'standard' },
      { action: 'fallback', provider: 'anthropic', tier: 'frontier' },
    ]);
  });
});

describe('tier chooser escaping and theme', () => {
  it('escapes a hostile model id and label without breaking the pinned payload', () => {
    const hostile = '"><script>alert(1)</script>';
    const html = buildTierChooserCard({
      tiers: [{ tier: 'cheap', model: hostile, label: hostile, inputPerM: hostile, outputPerM: hostile }],
    });

    expect(html).not.toContain(hostile);
    expect(html).toContain(escapeHtml(hostile));
    expect(payloads(html)).toEqual([{ tier: 'cheap', model: hostile }]);
    expect(summaries(html)).toEqual([`Selected Cheap Tier (${hostile})`]);
  });

  it('escapes hostile fallback provider, tier and message', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = buildQuotaFallbackCard({
      message: hostile,
      actions: [
        { kind: 'switch-provider', label: hostile, provider: hostile, tier: 'frontier' },
        { kind: 'downgrade-tier', label: 'Downgrade', provider: 'anthropic', tier: 'standard' },
        { kind: 'wait-for-reset', label: 'Wait', provider: 'anthropic', tier: 'frontier' },
      ],
    });

    expect(html).not.toContain(hostile);
    expect(html).toContain(escapeHtml(hostile));
    expect(payloads(html)[0]).toEqual({ action: 'fallback', provider: hostile, tier: 'frontier' });
  });

  it('uses the app CSS variables and the font-sans class from issue #14', () => {
    const chooser = buildTierChooserCard({ tiers: tiers() });
    const fallback = buildQuotaFallbackCard({ actions: fallbackActions() });

    for (const html of [chooser, fallback]) {
      expect(html).toContain('font-sans');
      expect(html).toContain('var(--bg-base)');
      expect(html).toContain('var(--text-primary)');
      expect(html).toContain('var(--border-base)');
      expect(html).toContain('var(--accent-primary)');
    }
  });
});
