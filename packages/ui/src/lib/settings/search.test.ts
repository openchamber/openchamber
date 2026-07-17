import { describe, test, expect } from 'bun:test';
import { SETTINGS_SEARCH_ITEMS } from './search';

describe('Settings Search Registry', () => {
  test('contains tunnel.direct-e2ee entry with correct properties', () => {
    const entry = SETTINGS_SEARCH_ITEMS.find(e => e.id === 'tunnel.direct-e2ee');
    expect(entry).toBeDefined();
    expect(entry?.page).toBe('tunnel');
    expect(entry?.titleKey).toBe('settings.openchamber.tunnel.field.directE2eeLabel');
    expect(entry?.keywords).toContain('end-to-end encryption');
    
    // Test availability guard
    const mockCtxVSCode = { isVSCode: true, isDesktop: false, platform: 'vscode' as const, isMobile: false, isDesktopLocalOrigin: false, isMac: false, isWindows: false, isWeb: false };
    const mockCtxWeb = { isVSCode: false, isDesktop: false, platform: 'web' as const, isMobile: false, isDesktopLocalOrigin: false, isMac: false, isWindows: false, isWeb: true };
    
    expect(entry?.isAvailable?.(mockCtxVSCode)).toBe(false);
    expect(entry?.isAvailable?.(mockCtxWeb)).toBe(true);
  });
});
