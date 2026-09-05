import { describe, expect, test } from 'bun:test';
import { enterSettingsSchema } from './settings-changes';

describe('VS Code Enter settings validation', () => {
  test('preserves both explicit choices', () => {
    expect(enterSettingsSchema.parse({ enterToSend: true, enterToSendConfigured: false }))
      .toEqual({ enterToSend: true, enterToSendConfigured: false });
    expect(enterSettingsSchema.parse({ enterToSend: false, enterToSendConfigured: true }))
      .toEqual({ enterToSend: false, enterToSendConfigured: true });
  });

  test('omits invalid fields independently', () => {
    expect(enterSettingsSchema.parse({ enterToSend: 'true', enterToSendConfigured: true }))
      .toEqual({ enterToSend: undefined, enterToSendConfigured: true });
    expect(enterSettingsSchema.parse({ enterToSend: false, enterToSendConfigured: 1 }))
      .toEqual({ enterToSend: false, enterToSendConfigured: undefined });
    expect(enterSettingsSchema.parse({})).toEqual({});
  });
});
