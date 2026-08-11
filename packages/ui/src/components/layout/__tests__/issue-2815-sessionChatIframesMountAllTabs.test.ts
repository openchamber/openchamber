/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2815
 *
 * [Bug] OpenChamber mounts all persisted session-chat iframes and freezes the
 * browser.
 *
 * Root cause under test: `ContextPanel` renders one full-application `<iframe>`
 * for EVERY chat tab in the context panel — including inactive tabs. Inactive
 * frames are only hidden with the Tailwind `hidden` class (`display: none`),
 * but a `display:none` iframe that carries a `src` is still navigated and
 * executed by the browser. After a reload, `useUIStore` restores every
 * persisted tab (via `sanitizeContextPanelByDirectory`), so N persisted
 * session-chat tabs become N embedded OpenChamber applications in a single
 * browser tab (the reported ~1 GB renderer freeze).
 *
 * We cannot mount the full `ContextPanel` in `bun test` (its import graph pulls
 * in a Vite `?worker&url` asset that Bun cannot resolve), so, following the
 * repo's existing regression-guard precedent (e.g.
 * `contextPanelEscapeClosesTerminal.test.ts`), this test:
 *   1. reads the real `ContextPanel.tsx` and asserts on the exact chat-frame
 *      render block that is responsible,
 *   2. drives the real `useUIStore` with the issue's persisted-tab scenario
 *      (8 read-only session-chat tabs + 3 other tabs = 11 tabs), and
 *   3. runs a faithful model of the extracted production render block against
 *      the store's real tab objects, using the real
 *      `buildEmbeddedSessionChatURL` helper, to show that all 8 session-chat
 *      tabs get a live `src` iframe (only 1 of them visible).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { buildEmbeddedSessionChatURL, resetEmbeddedSessionChatCache } from '../contextPanelEmbeddedChat';
import { useUIStore } from '@/stores/useUIStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');
const uiStoreSource = readFileSync(join(__dirname, '..', '..', '..', 'stores', 'useUIStore.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Local structural copies of the (unexported) tab/directory state types in
// useUIStore.ts so the fixture matches the real store shape exactly.
// ---------------------------------------------------------------------------

type FixtureContextPanelMode =
  | 'chat' | 'file' | 'context' | 'git' | 'diff' | 'plan' | 'preview'
  | 'browser' | 'pr' | 'notes' | 'terminal' | 'walkthrough';

type FixtureContextPanelTab = {
  id: string;
  mode: FixtureContextPanelMode;
  targetPath: string | null;
  dedupeKey: string;
  label: string | null;
  sessionTitleFallback: string | null;
  readOnly: boolean;
  stagedDiff: boolean;
  diffScope: string | null;
  touchedAt: number;
};

type FixtureContextPanelDirectoryState = {
  isOpen: boolean;
  expanded: boolean;
  tabs: FixtureContextPanelTab[];
  activeTabId: string | null;
  widthByMode: Partial<Record<FixtureContextPanelMode, number>>;
  touchedAt: number;
};

// ---------------------------------------------------------------------------
// Window stub so the real `buildEmbeddedSessionChatURL` can construct the
// embedded-frame URL (same approach as contextPanelEmbeddedChat.test.ts).
// ---------------------------------------------------------------------------

const originalWindow = globalThis.window;

const installWindowLocation = (href = 'http://127.0.0.1:3000/') => {
  const url = new URL(href);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
      },
    },
  });
};

const makeTheme = (variant: 'light' | 'dark'): Theme => getDefaultTheme(variant === 'dark');

beforeEach(() => {
  installWindowLocation();
  resetEmbeddedSessionChatCache();
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

// ---------------------------------------------------------------------------
// Faithful copy of the module-private helper from ContextPanel.tsx (lines
// 426-433). Kept structurally identical so the model behaves exactly like the
// production renderer.
// ---------------------------------------------------------------------------

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) {
    return null;
  }
  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

// ---------------------------------------------------------------------------
// The issue's persisted scenario: the active directory has 11 context-panel
// tabs, 8 of which are read-only session-chat tabs (plan/subagent sessions).
// Tab ids/dedupeKeys follow `createContextPanelTab` conventions
// (`chat:session:ses_…`).
// ---------------------------------------------------------------------------

const DIRECTORY = '/path/to/repository';

const buildChatTab = (sessionID: string, readOnly: boolean): FixtureContextPanelTab => ({
  id: `chat:session:${sessionID}`,
  mode: 'chat',
  targetPath: null,
  dedupeKey: `session:${sessionID}`,
  label: `Session ${sessionID}`,
  sessionTitleFallback: null,
  readOnly,
  stagedDiff: false,
  diffScope: 'working',
  touchedAt: Date.now(),
});

const buildNonChatTab = (mode: FixtureContextPanelMode, dedupeKey: string): FixtureContextPanelTab => ({
  id: dedupeKey,
  mode,
  targetPath: null,
  dedupeKey,
  label: null,
  sessionTitleFallback: null,
  readOnly: false,
  stagedDiff: false,
  diffScope: 'working',
  touchedAt: Date.now(),
});

// 8 read-only session-chat tabs (plan/subagent sessions), as persisted.
const sessionChatTabs = Array.from({ length: 8 }, (_, index) => (
  buildChatTab(`ses_${index + 1}`, true)
));

// The remaining 3 tabs of the active directory (matches the report: 11 total).
const otherTabs: FixtureContextPanelTab[] = [
  buildNonChatTab('git', 'git'),
  buildNonChatTab('diff', 'diff'),
  buildNonChatTab('plan', 'plan'),
];

const issueScenarioTabs = [...sessionChatTabs, ...otherTabs];

// Installs the issue's persisted-tab scenario into the real ui-store, exactly
// as it would look after a reload restored `contextPanelByDirectory`.
const installIssueScenario = () => {
  useUIStore.setState({
    contextPanelByDirectory: {
      [DIRECTORY]: {
        isOpen: true,
        expanded: false,
        tabs: issueScenarioTabs,
        activeTabId: 'chat:session:ses_1',
        widthByMode: {},
        touchedAt: Date.now(),
      } as FixtureContextPanelDirectoryState,
    } as never,
  });
};

// ---------------------------------------------------------------------------
// 1. Source evidence: the production render block mounts one iframe per chat
//    tab and only toggles visibility with the `hidden` CSS class.
// ---------------------------------------------------------------------------

describe('issue #2815 source evidence (ContextPanel.tsx)', () => {
  const extractChatFrameBlock = (): string => {
    const startMarker = '{chatTabs.map((tab) => {';
    const start = contextPanelSource.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    // The iframe is self-closing (`/>`), so anchor on the onLoad body that
    // precedes the block's closing `);` / `})}` — an earlier `})}` appears
    // inside the `title={t('...', { sessionID })}` expression.
    const onLoadBody = contextPanelSource.indexOf('postEmbeddedVisibilityToChats();', start);
    expect(onLoadBody).toBeGreaterThan(start);
    const end = contextPanelSource.indexOf('})}', onLoadBody);
    expect(end).toBeGreaterThan(onLoadBody);
    return contextPanelSource.slice(start, end + 3);
  };

  test('chat frames are rendered by mapping over ALL chat tabs', () => {
    const block = extractChatFrameBlock();
    expect(block.includes('{chatTabs.map((tab) => {')).toBe(true);
  });

  test('every chat tab unconditionally gets an <iframe> with a live src', () => {
    const block = extractChatFrameBlock();
    // The iframe is created for every tab that has a sessionID; visibility is
    // NOT a condition for mounting the iframe or setting its src.
    expect(block.includes('<iframe')).toBe(true);
    expect(block.includes('src={src}')).toBe(true);
    // No active-tab guard in front of the iframe element itself.
    expect(/activeChatTabID === tab\.id\s*&&/.test(block)).toBe(false);
  });

  test('inactive chat tabs are only hidden via the CSS `hidden` class', () => {
    const block = extractChatFrameBlock();
    // The ONLY active-tab distinction in the block is the visibility class.
    expect(block.includes("activeChatTabID === tab.id ? 'block' : 'hidden'")).toBe(true);
    // `hidden` maps to display:none; the iframe element and its src remain in
    // the DOM, so the browser still loads and executes the embedded app.
    const visibilitySwitchCount = block.match(/'block' : 'hidden'/g)?.length ?? 0;
    expect(visibilitySwitchCount).toBe(1);
  });

  test('inactive session-chat tabs are never conditionally unmounted', () => {
    const block = extractChatFrameBlock();
    // There is no `return null`/skip for inactive tabs: only tabs without a
    // sessionID or a usable src are skipped, never inactive ones.
    expect(/if\s*\(.*activeChatTabID.*\)\s*return null/.test(block)).toBe(false);
    expect(block.includes('if (!sessionID)')).toBe(true);
    expect(block.includes('if (!src)')).toBe(true);
  });
});

describe('issue #2815 source evidence (useUIStore.ts reload path)', () => {
  test('sanitizeContextPanelByDirectory restores every persisted tab, not just the active one', () => {
    // After a reload the persisted `tabs` array is restored in full; only the
    // `activeTabId` selects one of them. There is no filtering of inactive
    // session-chat tabs during hydration.
    const sanitizeStart = uiStoreSource.indexOf('const sanitizeContextPanelByDirectory = (');
    expect(sanitizeStart).toBeGreaterThan(-1);
    // The full persisted `tabs` array is restored; only the active tab id is
    // resolved separately. There is no filtering of inactive session-chat
    // tabs during hydration.
    expect(/\blet tabs = sanitizeContextPanelTabs\(candidate\.tabs\);/.test(uiStoreSource)).toBe(true);
    expect(/let activeTabId = typeof candidate\.activeTabId === 'string' \? candidate\.activeTabId : null/.test(uiStoreSource)).toBe(true);
    // It preserves the readOnly flag of persisted chat tabs.
    expect(/readOnly: candidate\.readOnly === true/.test(uiStoreSource)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Real store: the issue's persisted scenario is present after "reload".
// ---------------------------------------------------------------------------

describe('issue #2815 persisted scenario in the real ui-store', () => {
  beforeEach(() => {
    installIssueScenario();
  });

  test('all 8 persisted session-chat tabs survive hydration', () => {
    const tabs = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
    expect(tabs).toHaveLength(11);
    const readOnlyChat = tabs.filter((tab) => tab.mode === 'chat' && tab.readOnly);
    expect(readOnlyChat).toHaveLength(8);
  });

  test('exactly one tab is active while the other 7 session-chat tabs stay inactive', () => {
    const state = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(state?.activeTabId).toBe('chat:session:ses_1');
    const inactiveChatTabs = state?.tabs.filter(
      (tab) => tab.mode === 'chat' && tab.readOnly && tab.id !== state?.activeTabId,
    );
    expect(inactiveChatTabs).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// 3. Faithful model of the extracted production render block, run over the
//    real store's tab objects with the real URL builder. Demonstrates that a
//    reload mounts 8 embedded session-chat iframes (all with live srcs),
//    exactly the reported behavior.
// ---------------------------------------------------------------------------

describe('issue #2815 behavioral model (ContextPanel chat-frame render block)', () => {
  const theme = { mode: 'system' as const, lightThemeId: 'light', darkThemeId: 'dark', currentTheme: makeTheme('dark') };

  beforeEach(() => {
    installIssueScenario();
  });

  // Mirror of the production block in ContextPanel.tsx lines 2937-2971:
  //   chatTabs.map -> sessionID from dedupeKey -> src -> <iframe src ...>
  //   className: activeChatTabID === tab.id ? 'block' : 'hidden'
  const renderChatFramesModel = (tabs: FixtureContextPanelTab[], activeChatTabID: string | null) => {
    const frames: Array<{ tabID: string; sessionID: string; src: string; visibility: 'block' | 'hidden' }> = [];
    const chatTabs = tabs.filter((tab) => tab.mode === 'chat');
    for (const tab of chatTabs) {
      const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
      if (!sessionID) continue;
      const src = buildEmbeddedSessionChatURL(sessionID, DIRECTORY, tab.readOnly, theme);
      if (!src) continue;
      frames.push({
        tabID: tab.id,
        sessionID,
        src,
        visibility: activeChatTabID === tab.id ? 'block' : 'hidden',
      });
    }
    return frames;
  };

  test('mounts one embedded session-chat iframe per persisted chat tab (8 frames, 7 hidden)', () => {
    const tabs = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
    const activeTabId = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.activeTabId ?? null;

    const frames = renderChatFramesModel(tabs, activeTabId);

    // All 8 persisted session-chat tabs produce a live iframe.
    expect(frames).toHaveLength(8);
    expect(new Set(frames.map((f) => f.sessionID))).toEqual(
      new Set(sessionChatTabs.map((tab) => getSessionIDFromDedupeKey(tab.dedupeKey))),
    );

    // Only the active tab is visible; the other 7 are mounted-but-hidden.
    expect(frames.filter((f) => f.visibility === 'block')).toHaveLength(1);
    expect(frames.filter((f) => f.visibility === 'hidden')).toHaveLength(7);

    // Every iframe carries the full embedded-app URL the browser will load —
    // exactly the URL shape captured in the report.
    for (const frame of frames) {
      const url = new URL(frame.src);
      expect(url.searchParams.get('ocPanel')).toBe('session-chat');
      expect(url.searchParams.get('surface')).toBe('desktop');
      expect(url.searchParams.get('sessionId')).toBe(frame.sessionID);
      expect(url.searchParams.get('directory')).toBe(DIRECTORY);
      expect(url.searchParams.get('readOnly')).toBe('1');
    }
  });

  test('reload semantics: every persisted session-chat tab is mounted, hidden or not', () => {
    // Simulated reload: state is restored as-is from the persisted store
    // (sanitizeContextPanelByDirectory keeps all tabs), then the panel renders.
    const tabs = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
    const frames = renderChatFramesModel(tabs, 'chat:session:ses_1');

    const hiddenButMounted = frames.filter((f) => f.visibility === 'hidden');
    expect(hiddenButMounted.map((f) => f.src).every((src) => src.length > 0)).toBe(true);

    // A display:none iframe with a src is still loaded by the browser: this is
    // the exact mechanism behind the report's "8 embedded URLs, 9 app
    // instances, ~1 GB renderer RSS" measurements.
    expect(frames.length).toBe(8);
    expect(hiddenButMounted.length).toBe(7);
  });

  test('expected behavior contrast: mounting only the active tab would leave a single iframe', () => {
    // The issue's expected behavior: only the active session-chat tab is
    // mounted; inactive persisted tabs must not start an embedded application.
    // If the production render block gated mounting on the active tab (as it
    // already does for `activeNonChatContent` and the terminal surface), the
    // same persisted state would produce exactly one iframe.
    const tabs = useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
    const chatTabs = tabs.filter((tab) => tab.mode === 'chat');

    const frames = renderChatFramesModel(tabs, 'chat:session:ses_1');
    const activeOnlyFrames = frames.filter((f) => f.visibility === 'block');

    // The bug: every persisted chat tab is mounted...
    expect(frames.length).toBe(chatTabs.length);
    // ...while the intended behavior is a single mounted frame.
    expect(activeOnlyFrames.length).toBe(1);
  });
});
