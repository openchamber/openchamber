import { describe, expect, test } from 'bun:test';

import { registerContextPanelCloseHandler, requestContextPanelClose } from './contextPanelCloseRequest';

describe('context panel close request', () => {
  test('routes generic close entry points through the mounted lifecycle owner', () => {
    const directories: string[] = [];
    const unregister = registerContextPanelCloseHandler((directory) => {
      directories.push(directory);
      return true;
    });

    expect(requestContextPanelClose('/repo')).toBe(true);
    expect(directories).toEqual(['/repo']);

    unregister();
    expect(requestContextPanelClose('/repo')).toBe(false);
  });
});
