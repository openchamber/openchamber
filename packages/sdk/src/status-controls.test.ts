import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { parseGuestMessage, parseHostMessage } from './protocol.ts';
import { guestStatusControlEventSchema, guestStatusControlsSchema } from './status-control-schemas.ts';

const controls = [{
  kind: 'select' as const,
  id: 'branch',
  label: 'Branch',
  value: 'main',
  options: [{ value: 'main', label: 'Main' }, { value: 'next', label: 'Next' }],
}];

describe('status controls', () => {
  test('accepts bounded, typed control declarations and events', () => {
    expect(guestStatusControlsSchema.parse(controls)).toEqual(controls);
    expect(guestStatusControlEventSchema.parse({ id: 'branch', value: 'next' })).toEqual({ id: 'branch', value: 'next' });
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'status-controls', id: 'request-1', payload: { controls },
    })).toMatchObject({ type: 'status-controls', payload: { controls } });
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'status-controls', id: 'request-1', payload: controls,
    })).toBeNull();
    expect(parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'status-control-event', payload: { id: 'branch', value: 'next' },
    })).toMatchObject({ type: 'status-control-event', payload: { id: 'branch', value: 'next' } });
  });

  test('fails closed for duplicate, stale, oversized, and malformed controls', () => {
    expect(guestStatusControlsSchema.safeParse([...controls, { kind: 'button', id: 'branch', label: 'Refresh' }]).success).toBe(false);
    expect(guestStatusControlsSchema.safeParse([{ ...controls[0], options: [{ value: 'main', label: 'Main' }, { value: 'main', label: 'Again' }] }]).success).toBe(false);
    expect(guestStatusControlsSchema.safeParse([{ ...controls[0], value: 'missing' }]).success).toBe(false);
    expect(guestStatusControlsSchema.safeParse(Array.from({ length: 5 }, (_, index) => ({ kind: 'button', id: `item-${index}`, label: 'Control' }))).success).toBe(false);
    expect(guestStatusControlEventSchema.safeParse({ id: 'branch', value: '', extra: true }).success).toBe(false);
  });
});
