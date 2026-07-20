import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./MobileSessionStatusBar.tsx', import.meta.url), 'utf8');

describe('MobileSessionStatusBar hidden work', () => {
  test('does not mount session grouping and project derivation while the panel is closed', () => {
    const wrapperStart = source.indexOf('export const MobileSessionStatusBar');
    const openPanelStart = source.indexOf('const MobileSessionStatusOpenPanel');
    const closedGuard = source.indexOf('if (!isMobile || !open) return null;', wrapperStart);
    const openPanelMount = source.indexOf('<MobileSessionStatusOpenPanel', wrapperStart);

    expect(openPanelStart).toBeGreaterThan(-1);
    expect(closedGuard).toBeGreaterThan(wrapperStart);
    expect(openPanelMount).toBeGreaterThan(closedGuard);
    expect(source.indexOf('useSessionGrouping(', openPanelStart)).toBeLessThan(wrapperStart);
  });
});
