import { describe, expect, test } from 'bun:test';

import { guestStatusViewSchema } from './status-view-schemas.ts';
import type { GuestStatusView } from './status-view.ts';

const view: GuestStatusView = {
  rows: [
    {
      kind: 'line', id: 'app', label: 'OpenChamber', value: '1.6 GB · 115%',
      content: { kind: 'chart', values: [1, 2, 3], tone: 'accent', unit: 'bytes', step: 2 },
    },
    { kind: 'line', id: 'cpu', label: 'CPU', content: { kind: 'bar', value: 25, tone: 'info' }, value: '25%' },
    {
      kind: 'line', id: 'servers', label: 'Dev servers',
      content: { kind: 'chips', chips: [{ id: 'p5173', label: ':5173', url: 'http://localhost:5173' }] },
    },
    {
      kind: 'line', id: 'web', label: 'web', dot: 'success', badge: { label: 'running', tone: 'success' },
      actions: [
        { kind: 'button', id: 'stop-web', label: 'Stop', variant: 'destructive', confirm: 'Stop web?' },
        { kind: 'switch', id: 'watch-web', label: 'Watch', checked: true },
      ],
    },
    {
      kind: 'line', id: 'range', label: 'Period',
      content: { kind: 'segmented', id: 'period', label: 'Period', value: '5m', options: [{ value: '1m', label: '1m' }, { value: '5m', label: '5m' }] },
    },
    { kind: 'note', id: 'hint', text: 'Docker isn\'t running.', tone: 'warning' },
  ],
  controls: [{ kind: 'button', id: 'refresh', label: 'Refresh' }],
};

describe('guestStatusViewSchema', () => {
  test('accepts every element', () => {
    expect(guestStatusViewSchema.safeParse(view).success).toBe(true);
    expect(guestStatusViewSchema.safeParse({ rows: [] }).success).toBe(true);
  });

  test('refuses duplicate row ids and control ids shared across the view', () => {
    const [first] = view.rows;
    if (!first) throw new Error('fixture');
    expect(guestStatusViewSchema.safeParse({ rows: [first, first] }).success).toBe(false);
    expect(guestStatusViewSchema.safeParse({
      ...view, controls: [{ kind: 'button', id: 'stop-web', label: 'Stop' }],
    }).success).toBe(false);
  });

  test('refuses unknown fields, colours and links that are not http(s)', () => {
    for (const row of [
      { kind: 'line', id: 'a', label: 'A', color: '#f00' },
      { kind: 'line', id: 'a', label: 'A', dot: 'pink' },
      { kind: 'line', id: 'a', label: 'A', content: { kind: 'chips', chips: [{ id: 'x', label: 'x', url: 'javascript:alert(1)' }] } },
      { kind: 'line', id: 'a', label: 'A', content: { kind: 'bar', value: 140 } },
      { kind: 'line', id: 'a', label: 'A', content: { kind: 'chart', values: [Number.NaN] } },
      { kind: 'line', id: 'Bad Id', label: 'A' },
      { kind: 'note', id: 'n', text: '' },
    ]) {
      expect(guestStatusViewSchema.safeParse({ rows: [row] }).success).toBe(false);
    }
  });

  test('a choice must hold its own value', () => {
    expect(guestStatusViewSchema.safeParse({
      rows: [{ kind: 'line', id: 'a', label: 'A', actions: [{ kind: 'select', id: 's', label: 'S', value: 'z', options: [{ value: 'a', label: 'A' }] }] }],
    }).success).toBe(false);
  });
});
