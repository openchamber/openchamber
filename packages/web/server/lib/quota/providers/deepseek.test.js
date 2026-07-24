import { describe, expect, it } from 'vitest';

import { buildDeepseekWindow } from './deepseek.js';

const HOUR = 3_600_000;

describe('buildDeepseekWindow', () => {
  it('formats a USD balance as the value label', () => {
    const w = buildDeepseekWindow({ currency: 'USD', total_balance: '43.53' }, []);
    expect(w.valueLabel).toBe('$43.53');
  });

  it('omits credits burn until there are enough samples', () => {
    const w = buildDeepseekWindow({ currency: 'USD', total_balance: '43.53' }, [
      { balance: 43.53, currency: 'USD', at: Date.now() }
    ]);
    expect(w.credits).toBeUndefined();
  });

  it('emits burn + runway once the balance has decreased over time', () => {
    const now = Date.now();
    const w = buildDeepseekWindow({ currency: 'USD', total_balance: '43.00' }, [
      { balance: 44, currency: 'USD', at: now - 2 * HOUR },
      { balance: 43, currency: 'USD', at: now }
    ]);
    expect(w.credits).not.toBeNull();
    expect(w.credits.symbol).toBe('$');
    expect(w.credits.burnPerHour).toBeCloseTo(0.5, 6);
    expect(w.credits.runwaySeconds).toBeGreaterThan(0);
  });

  it('uses the yuan symbol for CNY accounts', () => {
    const w = buildDeepseekWindow({ currency: 'CNY', total_balance: '110.00' }, []);
    expect(w.valueLabel).toBe('\u00a5110.00');
  });
});
