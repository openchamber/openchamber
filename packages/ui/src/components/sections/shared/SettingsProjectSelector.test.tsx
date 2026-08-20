/**
 * Regression tests for https://github.com/openchamber/openchamber/issues/2999
 *
 * The settings sections (Agents, Commands, MCP, Providers, Skills) each embed
 * a per-project selector built from SettingsProjectSelector. That selector
 * rendered a DropdownMenu whose content had no height cap and no scroll
 * container, so on mobile a long project list opened past the bottom of the
 * screen and projects below the fold were unreachable.
 *
 * The fix reuses the main-view selector approach: shared Select primitives
 * whose SelectContent caps the popup to the available viewport height
 * (max-h-[var(--available-height)] + ScrollableOverlay) and scrolls
 * internally, with project icon/color parity via the main-view ProjectLabel.
 *
 * The base-ui Select popup only renders when open, so popup-related behavior
 * is asserted as source contracts (the repo's established pattern for
 * portaled UI, cf. terminalViewportRemount.test.ts) while ordering is
 * verified through the exported pure helper.
 */
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useProjectsStore } from '@/stores/useProjectsStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const selectorSource = readFileSync(join(__dirname, 'SettingsProjectSelector.tsx'), 'utf-8');

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
}));

const { themes } = await import('@/lib/theme/themes');

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: themes[0] }),
}));

const { SettingsProjectSelector, sortSettingsProjects } = await import('./SettingsProjectSelector');
const { I18nProvider } = await import('@/lib/i18n');
const { renderToStaticMarkup } = await import('react-dom/server');

describe('SettingsProjectSelector (#2999)', () => {
  test('desktop renders through Select primitives so the popup is viewport-capped and internally scrolling', () => {
    expect(selectorSource).toContain("from '@/components/ui/select'");
    expect(selectorSource).toContain('<SelectContent');
    expect(selectorSource).not.toContain("from '@/components/ui/dropdown-menu'");
    expect(selectorSource).not.toContain('<DropdownMenu');
  });

  test('mobile reuses the composer bottom-sheet project picker instead of a popup', () => {
    expect(selectorSource).toContain('ProjectPickerSheet');
    expect(selectorSource).toContain('state.isMobile');
  });

  test('renders project icon and color metadata for parity with the main-view selector', () => {
    expect(selectorSource).toContain("from '@/components/chat/composer/ui/DraftTargetSelectors'");
    expect(selectorSource).toContain('<ProjectLabel');
  });

  test('keeps hiding itself on the VS Code runtime', () => {
    expect(selectorSource).toContain('isVSCodeRuntime');
    expect(selectorSource).toContain('if (isVSCode || !activeProject)');
  });

  test('sorts projects alphabetically by display label', () => {
    const sorted = sortSettingsProjects([
      { id: 'zeta', path: '/home/dev/zeta', label: 'Zeta' },
      { id: 'alpha', path: '/home/dev/alpha' },
      { id: 'beta', path: '/home/dev/beta', label: 'beta' },
    ]);
    expect(sorted.map((project) => project.id)).toEqual(['alpha', 'beta', 'zeta']);
  });

  test('renders nothing without projects', () => {
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    const html = renderToStaticMarkup(<I18nProvider><SettingsProjectSelector /></I18nProvider>);
    expect(html).toBe('');
  });
});
