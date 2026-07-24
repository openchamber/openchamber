import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainLayoutSource = readFileSync(
    join(__dirname, '..', 'MainLayout.tsx'),
    'utf-8',
);
const sessionSidebarSource = readFileSync(
    join(__dirname, '..', '..', 'session', 'SessionSidebar.tsx'),
    'utf-8',
);

describe('MainLayout mobile SessionSidebar mount (issue #1695 regression guard)', () => {
    test('mobile SessionSidebar is not conditionally mounted on mobileLeftDrawerVisible', () => {
        const mobileSidebarIndex = mainLayoutSource.indexOf('<SessionSidebar mobileVariant');
        expect(mobileSidebarIndex).toBeGreaterThan(-1);

        const windowStart = Math.max(0, mobileSidebarIndex - 400);
        const precedingWindow = mainLayoutSource.slice(windowStart, mobileSidebarIndex);

        expect(/\{\s*mobileLeftDrawerVisible\s*&&\s*\(/.test(precedingWindow)).toBe(false);

        expect(precedingWindow.includes('pointer-events-none')).toBe(true);
        expect(mainLayoutSource.slice(mobileSidebarIndex, mobileSidebarIndex + 120)).toContain('isVisible={mobileLeftDrawerVisible}');
    });

    test('desktop SessionSidebar is rendered inside Sidebar without drawer-visibility gating', () => {
        const desktopSidebarIndex = mainLayoutSource.indexOf('<SessionSidebar isVisible={isSidebarOpen} />');
        expect(desktopSidebarIndex).toBeGreaterThan(-1);

        const windowStart = Math.max(0, desktopSidebarIndex - 300);
        const precedingWindow = mainLayoutSource.slice(windowStart, desktopSidebarIndex);

        expect(precedingWindow).toContain('<Sidebar');
        expect(/mobileLeftDrawerVisible\s*&&/.test(precedingWindow)).toBe(false);
    });

    test('hidden sidebars disable render-only subscriptions and effects', () => {
        expect(sessionSidebarSource).toContain('useGitAllBranches(isVisible)');
        expect(sessionSidebarSource).toContain('useGitRepoStatusMap(isVisible ? normalizedProjectPaths : EMPTY_STRING_ARRAY)');
        expect(sessionSidebarSource).toContain('enabled: isVisible,\n    isSessionSearchOpen');
        expect(sessionSidebarSource).toContain('enabled: isVisible,\n    isDesktopShellRuntime');
        expect(sessionSidebarSource).toContain('if (!isVisible) return EMPTY_STRING_ARRAY;');
    });
});
