import { describe, expect, it } from 'vitest';

import { toUsageWindow } from './formatters.js';
import { buildProviderCard } from '../view-models.js';

describe('toUsageWindow resetText passthrough', () => {
  it('includes resetText when provided', () => {
    const w = toUsageWindow({ usedPercent: 40, resetText: '5d 3h' });
    expect(w.resetText).toBe('5d 3h');
  });

  it('omits resetText when not provided', () => {
    const w = toUsageWindow({ usedPercent: 40 });
    expect(w).not.toHaveProperty('resetText');
  });

  it('omits resetText when empty string', () => {
    const w = toUsageWindow({ usedPercent: 40, resetText: '' });
    expect(w).not.toHaveProperty('resetText');
  });
});

describe('buildProviderCard preserves rich usage fields', () => {
  const baseResult = {
    providerId: 'openai',
    providerName: 'OpenAI',
    ok: true,
    configured: true,
    fetchedAt: 1700000000000,
    usage: {
      subtitle: 'me@example.com',
      note: '(cached 3m ago)',
      header: ['Account: me@example.com', 'Plan: Pro'],
      footer: ['Zen balance: $1.23'],
      windows: {
        '5h': {
          usedPercent: 60,
          remainingPercent: 40,
          windowSeconds: 18000,
          resetAt: 1700000000000,
          resetAfterSeconds: 100,
          resetAtFormatted: 'now',
          resetAfterFormatted: 'now',
          resetText: '5d 3h',
          valueLabel: 'primary',
          suffix: '%',
          detail: ['line1'],
          extra: ['extra1'],
          warn: 'throttled',
          sectionHeader: 'Primary',
          trendKey: 'primary'
        }
      },
      accounts: [
        {
          accountKey: 'alt1',
          label: 'Alt 1',
          subtitle: 'alt@example.com',
          note: 'secondary',
          header: ['Account: alt@example.com'],
          windows: {
            '5h': {
              usedPercent: 10,
              remainingPercent: 90,
              windowSeconds: 18000,
              resetAt: null,
              resetAfterSeconds: null,
              resetAtFormatted: null,
              resetAfterFormatted: null,
              resetText: '2h'
            }
          },
          footer: ['alt footer']
        }
      ]
    }
  };

  it('propagates usage.subtitle/note/header/footer', () => {
    const card = buildProviderCard(baseResult);
    expect(card.usageSubtitle).toBe('me@example.com');
    expect(card.usageNote).toBe('(cached 3m ago)');
    expect(card.usageHeader).toEqual(['Account: me@example.com', 'Plan: Pro']);
    expect(card.usageFooter).toEqual(['Zen balance: $1.23']);
  });

  it('propagates usage.accounts', () => {
    const card = buildProviderCard(baseResult);
    expect(Array.isArray(card.accounts)).toBe(true);
    expect(card.accounts).toHaveLength(1);
    const acct = card.accounts[0];
    expect(acct.accountKey).toBe('alt1');
    expect(acct.label).toBe('Alt 1');
    expect(acct.subtitle).toBe('alt@example.com');
    expect(acct.note).toBe('secondary');
    expect(acct.header).toEqual(['Account: alt@example.com']);
    expect(acct.footer).toEqual(['alt footer']);
    expect(acct.windows['5h'].resetText).toBe('2h');
  });

  it('propagates window resetText', () => {
    const card = buildProviderCard(baseResult);
    const win = card.windows.find((w) => w.key === '5h');
    expect(win.resetText).toBe('5d 3h');
  });

  it('omits rich fields when usage lacks them', () => {
    const card = buildProviderCard({
      providerId: 'openai',
      providerName: 'OpenAI',
      ok: true,
      configured: true,
      fetchedAt: 1700000000000,
      usage: { windows: {} }
    });
    expect(card.usageSubtitle).toBeNull();
    expect(card.usageNote).toBeNull();
    expect(card.usageHeader).toBeNull();
    expect(card.usageFooter).toBeNull();
    expect(card.accounts).toEqual([]);
  });
});