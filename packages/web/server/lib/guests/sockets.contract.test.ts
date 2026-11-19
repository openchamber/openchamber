import { expect, test } from 'vitest';
import { resolveSocketBinding } from './sockets.js';

test('a socket without platform candidates remains a valid binding', async () => {
  expect(await resolveSocketBinding({ id: 'optional' })).toBeNull();
});
