import { describe, expect, it } from 'vitest';

import { readConsoleBudgets, withConsoleBudgets } from './console-budgets.js';

const budget = (overrides = {}) => ({
  id: 'bud_1',
  limit: 50,
  spent: 10,
  scope: 'each',
  per: 'set',
  coverage: 'all',
  models: [],
  vendors: [],
  picked: false,
  shared: false,
  resetsAt: 1_800_000_000_000,
  ...overrides,
});

const meter = { percent: 10, limited: false, resetsAt: 1_800_000_000_000 };
const limits = (budgets, name = 'Acme', go = { rolling: meter, weekly: meter, monthly: meter }) => {
  const info = { workspace: { id: 'wrk', name, usageURL: 'https://opencode.ai/x' }, budgets };
  if (go) info.go = go;
  return info;
};

describe('readConsoleBudgets', () => {
  it('orders budgets by what runs out first and names what each counts and who shares it', async () => {
    const result = await readConsoleBudgets(async () => limits([
      budget(),
      budget({ id: 'bud_2', limit: 20, spent: 19, scope: 'combined', shared: true, coverage: 'models', vendors: ['Anthropic'], per: 'model' }),
      budget({ id: 'bud_3', scope: 'combined', coverage: 'models', picked: true, models: [{ name: 'Sonnet' }], inputPriceAtLeast: 3 }),
    ]));

    expect(result.workspace).toBe('Acme');
    expect(result.goSubscribed).toBe(true);
    expect(result.budgets.map((entry) => entry.id)).toEqual(['bud_2', 'bud_1', 'bud_3']);
    expect(result.budgets[0]).toMatchObject({ kind: 'vendors', perModel: true, sharing: 'everyone', usedPercent: 95, reached: false });
    expect(result.budgets[1]).toMatchObject({ kind: 'all', sharing: 'you', usedPercent: 20 });
    expect(result.budgets[2]).toMatchObject({ kind: 'price', sharing: 'group', models: ['Sonnet'], inputPriceAtLeast: 3 });
  });

  it('marks a spent budget reached and drops one that does not parse', async () => {
    const result = await readConsoleBudgets(async () => limits([budget({ spent: 60 }), { id: 'broken' }]));
    expect(result.budgets).toHaveLength(1);
    expect(result.budgets[0]).toMatchObject({ reached: true, usedPercent: 100 });
  });

  it('answers null without a sign-in, without budgets, or when OpenCode cannot be asked', async () => {
    await expect(readConsoleBudgets(async () => null)).resolves.toBeNull();
    await expect(readConsoleBudgets(async () => limits([]))).resolves.toBeNull();
    await expect(readConsoleBudgets(async () => { throw new Error('OpenCode is down'); })).resolves.toBeNull();
  });
});

describe('withConsoleBudgets', () => {
  const read = (goSubscribed) => ({ workspace: null, budgets: [], goSubscribed });
  const shown = { workspace: null, budgets: [] };

  it('puts the budgets beside the Go windows', () => {
    const result = withConsoleBudgets({ ok: true, configured: true, usage: { windows: { weekly: {} } } }, read(true));
    expect(result.usage).toEqual({ windows: { weekly: {} }, consoleBudgets: shown });
  });

  it('keeps a failed Go read a failure while the workspace has Go, so the last meters stay', () => {
    const go = { ok: false, configured: true, usage: null, error: 'OpenCode Go usage API returned HTTP 502' };
    expect(withConsoleBudgets(go, read(true))).toBe(go);
  });

  it('shows the budgets with the Go error when the workspace has no Go', () => {
    const result = withConsoleBudgets({ ok: false, configured: true, usage: null, error: 'No Go' }, read(false));
    expect(result).toMatchObject({ ok: true, error: 'No Go', usage: { windows: {}, consoleBudgets: shown } });
  });

  it('leaves the result alone without budgets', () => {
    const go = { ok: false, configured: true, usage: null, error: 'No Go' };
    expect(withConsoleBudgets(go, null)).toBe(go);
  });
});
