import { describe, expect, it } from 'vitest';
import { SOURCE_CONTROL_PROVIDERS } from './providers.js';
import { SOURCE_CONTROL_PROVIDERS as UI_SOURCE_CONTROL_PROVIDERS } from '../../../../ui/src/lib/source-control/providers.ts';

describe('source-control provider list parity', () => {
  it('keeps the server and UI lists equal', () => {
    expect(UI_SOURCE_CONTROL_PROVIDERS).toEqual(SOURCE_CONTROL_PROVIDERS);
  });
});
