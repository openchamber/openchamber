import { expect, test } from 'vitest';
import { serviceHostCallSchema } from '@openchamber/sdk/schemas';
import { createGuestMarks } from './marks.js';

test('stores the parsed mark shape, including explicit undefined fields', () => {
  const parsed = serviceHostCallSchema.parse({
    method: 'marks.set',
    input: {
      target: { directory: '/repo', branch: undefined },
      mark: { icon: 'checkbox-circle', tone: 'success', text: 'Passed', url: undefined },
    },
  });
  if (parsed.method !== 'marks.set') throw new Error('Expected marks.set');
  const marks = createGuestMarks({ guestIdOfToken: () => 'desk' });
  expect(marks.set('desk', 'token', parsed.input.target, parsed.input.mark)).toBe('changed');
  expect(marks.list('desk')).toStrictEqual([parsed.input]);
  expect(marks.set('desk', 'token', { directory: '/other' }, { icon: 'checkbox-circle', tone: 'success', text: 'Passed' })).toBe('changed');
  expect(marks.list('desk')[1]).toStrictEqual({
    target: { directory: '/other' },
    mark: { icon: 'checkbox-circle', tone: 'success', text: 'Passed' },
  });
});
