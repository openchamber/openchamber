import { expect, test } from 'bun:test';

import { dict } from '@/lib/i18n/messages/en';
import { pushDeliveryLocalOnlyHintKey } from './usePushDeliveryLocalOnly';

const hint = (scope: Parameters<typeof pushDeliveryLocalOnlyHintKey>[0]) => {
  const key = pushDeliveryLocalOnlyHintKey(scope);
  return key ? dict[key] : null;
};

test('a home-network-only server says it stays silent while other saved servers deliver', () => {
  expect(hint('server')).toBe("This server is paired for your home network only, so it doesn't send notifications. Your other saved servers still do.");
});

test('a phone with no other saved server keeps its own explanation, and a delivering server shows none', () => {
  expect(hint('device')).toContain('This device is paired for your home network only, so it gets no notifications');
  expect(hint(null)).toBeNull();
});
