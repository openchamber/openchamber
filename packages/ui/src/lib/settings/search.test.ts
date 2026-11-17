import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { I18nKey } from '@/lib/i18n/store';
import { getCustomizableShortcutActions } from '@/lib/shortcuts';
import { buildSettingsSearchResults, shortcutSearchItemId } from './search';

const t = (key: I18nKey): string => key;

const runtimeCtx = {
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  routingAvailable: false,
  enterpriseMode: false,
  jevBlockedByEnterprise: false,
  messagingSupported: true,
};

describe('settings search', () => {
  test('indexes live messaging controls only on supported servers and keeps editable config searchable', () => {
    const live = ['model', 'autostart', 'model-url', 'model-path', 'pooling', 'threads', 'gpu-layers', 'server', 'query', 'presets', 'constants', 'variables'];
    const editable = ['remote', 'search', 'delivery', 'session-start'];
    for (const messagingSupported of [false, true]) {
      const results = buildSettingsSearchResults({ query: 'messaging', runtimeCtx: { ...runtimeCtx, messagingSupported }, t, getPageTitle: (page) => page });
      for (const id of live) expect(results.some((result) => result.id === `messaging.${id}`)).toBe(messagingSupported);
      for (const id of editable) expect(results.some((result) => result.id === `messaging.${id}`)).toBe(true);
    }
  });

  test('finds double-paste on every shared Settings surface', () => {
    for (const query of ['double paste', 'ctrl v', 'cmd v']) {
      for (const context of [runtimeCtx, { ...runtimeCtx, isDesktop: true }, { ...runtimeCtx, isVSCode: true }, { ...runtimeCtx, isMobile: true }]) {
        const results = buildSettingsSearchResults({ query, runtimeCtx: context, t, getPageTitle: (page) => page });
        expect(results.find((result) => result.id === 'chat.large-text-paste')?.page).toBe('chat');
      }
    }
  });
  test('finds the Claude Code integration by name and package, never in VS Code or enterprise mode', () => {
    for (const query of ['claude', '@openchamber/opencode-claude']) {
      for (const isVSCode of [false, true]) {
        for (const enterpriseMode of [false, true]) {
          const results = buildSettingsSearchResults({
            query,
            runtimeCtx: { ...runtimeCtx, isVSCode, enterpriseMode },
            t,
            getPageTitle: (page) => page,
          });

          expect(results.some((result) => result.id === 'integrations.third-party.opencode-claude'))
            .toBe(!isVSCode && !enterpriseMode);
        }
      }
    }
  });

  test('Enter-to-send is searchable only outside mobile', () => {
    for (const isMobile of [false, true]) {
      const results = buildSettingsSearchResults({
        query: 'shift enter',
        runtimeCtx: { ...runtimeCtx, isMobile },
        t,
        getPageTitle: (page) => page,
      });

      expect(results.some((result) => result.id === 'chat.enter-to-send')).toBe(!isMobile);
    }
  });

  test('finds the scrollbar preference on every surface', () => {
    for (const context of [runtimeCtx, { ...runtimeCtx, isDesktop: true }, { ...runtimeCtx, isVSCode: true }, { ...runtimeCtx, isMobile: true }]) {
      const results = buildSettingsSearchResults({
        query: 'scrollbar',
        runtimeCtx: context,
        t,
        getPageTitle: (page) => page,
      });
      expect(results.find((result) => result.id === 'appearance.scrollbars')?.page).toBe('appearance');
    }
  });
  test('finds Linear connect on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(true);
  });

  test('routing.token is a Providers result and providers.classification is unchanged (#1762)', () => {
    const ctx = { ...runtimeCtx, routingAvailable: true };
    const tokenResults = buildSettingsSearchResults({ query: 'typesafe', runtimeCtx: ctx, t, getPageTitle: (page) => page });
    expect(tokenResults.find((result) => result.id === 'routing.token')?.page).toBe('providers');

    const classificationResults = buildSettingsSearchResults({ query: 'classification', runtimeCtx: ctx, t, getPageTitle: (page) => page });
    expect(classificationResults.find((result) => result.id === 'providers.classification')?.page).toBe('providers');
  });

  test('finds the chat input history scope setting', () => {
    const results = buildSettingsSearchResults({
      query: 'input history scope',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'chat.input-history-scope')).toBe(true);
  });

  test('finds the chat input history limit setting by recall keywords', () => {
    const results = buildSettingsSearchResults({
      query: 'remember prompts',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'chat.input-history-limit')).toBe(true);
  });

  test('hides Linear connect in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(false);
  });

  test('keeps repository controls out of Settings search and indexes account connection controls', () => {
    const results = buildSettingsSearchResults({
      query: 'source control account',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'git.source-control-account')).toBe(false);
    expect(results.some((result) => result.id.includes('github.com#'))).toBe(false);

    const connectResults = buildSettingsSearchResults({
      query: 'connect account',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });
    expect(connectResults.some((result) => result.id === 'git.github-connect')).toBe(true);
    expect(connectResults.some((result) => result.id === 'git.gitlab-connect')).toBe(true);
  });

  test('keeps repository transport and provider controls out of VS Code Settings search', () => {
    const vscodeCtx = { ...runtimeCtx, isVSCode: true, isWeb: false };
    const transportResults = buildSettingsSearchResults({
      query: 'transport',
      runtimeCtx: vscodeCtx,
      t,
      getPageTitle: (page) => page,
    });
    const accountResults = buildSettingsSearchResults({
      query: 'account',
      runtimeCtx: vscodeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(transportResults.some((result) => result.id === 'git.repository-transport')).toBe(false);
    expect(accountResults.some((result) => result.id === 'git.github-account')).toBe(false);
    expect(accountResults.some((result) => result.id === 'git.gitlab-account')).toBe(false);
  });

  test('finds guest extension panels on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'gitlab',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });
    expect(results.some((result) => result.id === 'integrations.guests')).toBe(true);
  });

  test('hides guest extension panels in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'clickup',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });
    expect(results.some((result) => result.id === 'integrations.guests')).toBe(false);
  });

  test('finds the project visibility switches everywhere but VS Code, whose project page has none', () => {
    for (const isVSCode of [false, true]) {
      const results = buildSettingsSearchResults({
        query: 'visibility',
        runtimeCtx: { ...runtimeCtx, isVSCode },
        t,
        getPageTitle: (page) => page,
      });
      const found = results.filter((result) => result.id.startsWith('projects.sidebar.')).map((result) => result.id).sort();
      expect({ isVSCode, found }).toEqual({ isVSCode, found: isVSCode ? [] : ['projects.sidebar.all', 'projects.sidebar.work'] });
    }
  });
});

describe('settings search anchors', () => {
  const componentsDir = join(__dirname, '..', '..', 'components');
  const settingsViewPath = join(componentsDir, 'views', 'SettingsView.tsx');
  const shortcutsPagePath = join(componentsDir, 'sections', 'openchamber', 'KeyboardShortcutsSettings.tsx');

  /** Every component source under components/, keyed by absolute path. */
  const readComponentSources = (): Map<string, string> => {
    const sources = new Map<string, string>();
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) collect(entryPath);
        else if (entry.name.endsWith('.tsx')) sources.set(entryPath, readFileSync(entryPath, 'utf-8'));
      }
    };
    collect(componentsDir);
    return sources;
  };

  /** Resolves a relative import specifier to the module file on disk. */
  const resolveModuleFile = (fromFile: string, specifier: string): string | null => {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  /**
   * The ids of every entry in search.ts: the literal ids plus the shortcut ids
   * generated from the shortcut schema, which the index builds through
   * shortcutSearchItemId. Also returns every `id:` field so the test can refuse
   * an entry whose id it cannot see.
   */
  const readSearchIndex = () => {
    const source = readFileSync(join(__dirname, 'search.ts'), 'utf-8');
    const literalIds = Array.from(
      source.matchAll(/id: '([^']+)',\s*page: '[^']+'/g),
      (match) => match[1],
    );
    const shortcutIds = getCustomizableShortcutActions()
      .filter((action) => action.category !== 'desktop')
      .map((action) => shortcutSearchItemId(action.id));
    const idFields = Array.from(
      source.matchAll(/\bid:\s*([^,\n]+),/g),
      (match) => match[1].trim(),
    );
    return { ids: [...literalIds, ...shortcutIds], idFields };
  };

  /**
   * A search result is revealed by finding [data-settings-item="<id>"] on the
   * page, so every entry needs an anchor in a component (#325). Most are
   * literal settingsItem/data-settings-item props; the helpers below read the
   * anchors components build at render time from the sources that own them, so
   * removing a construction fails the test instead of shipping a result that
   * highlights nothing.
   */
  const collectLiteralAnchors = (sources: Map<string, string>): Set<string> => {
    const anchors = new Set<string>();
    for (const source of sources.values()) {
      for (const match of source.matchAll(/(?:settingsItem|data-settings-item)=\{?["']([^"']+)["']/g)) {
        anchors.add(match[1]);
      }
      // settingsItem={cond ? 'a' : 'b'} — both branches anchor a control.
      for (const match of source.matchAll(/(?:settingsItem|data-settings-item)=\{([^}]*)\}/g)) {
        if (!match[1].includes('?')) continue;
        for (const literal of match[1].matchAll(/'([^']+)'/g)) anchors.add(literal[1]);
      }
    }
    return anchors;
  };

  /**
   * settingsItem={`prefix.${definition.field}`} over an imported catalog: one
   * anchor per catalog entry, read from the entry ids in that module.
   */
  const collectCatalogAnchors = (sources: Map<string, string>): Set<string> => {
    const anchors = new Set<string>();
    for (const [filePath, source] of sources) {
      const imports = new Map<string, string>();
      for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
        for (const name of match[1].split(',')) {
          const imported = name.trim().replace(/^type\s+/, '');
          if (imported) imports.set(imported, match[2]);
        }
      }
      for (const template of source.matchAll(/(?:settingsItem|data-settings-item)=\{`([^`$]+)\$\{([\w.]+)\}`\}/g)) {
        const prefix = template[1];
        const accessor = template[2];
        const field = accessor.split('.').pop();
        if (!field) continue;
        for (const map of source.matchAll(/([A-Z][A-Z0-9_]*)\.map\(/g)) {
          const specifier = imports.get(map[1]);
          if (!specifier) continue;
          const modulePath = resolveModuleFile(filePath, specifier);
          if (!modulePath) continue;
          const moduleSource = readFileSync(modulePath, 'utf-8');
          for (const value of moduleSource.matchAll(new RegExp(`\\b${field}: '([^']+)'`, 'g'))) {
            anchors.add(`${prefix}${value[1]}`);
          }
        }
      }
    }
    return anchors;
  };

  /**
   * The Shortcuts page renders one row per customizable in-app action through
   * shortcutSearchItemId(action.id); that call is the anchor for every
   * generated shortcut id.
   */
  const collectShortcutAnchors = (sources: Map<string, string>): Set<string> => {
    const anchors = new Set<string>();
    const page = sources.get(shortcutsPagePath);
    if (!page || !/settingsItem=\{shortcutSearchItemId\(action\.id\)\}/.test(page)) return anchors;
    for (const action of getCustomizableShortcutActions()) {
      if (action.category !== 'desktop') anchors.add(shortcutSearchItemId(action.id));
    }
    return anchors;
  };

  /**
   * prepareSettingsSearchTarget can open a result on a different anchor (the
   * Git identity picker lives in the Add extension dialog), so the redirect
   * target is the id that must be anchored.
   */
  const collectRedirects = (sources: Map<string, string>): Map<string, string> => {
    const redirects = new Map<string, string>();
    const settingsView = sources.get(settingsViewPath);
    if (!settingsView) return redirects;
    for (const match of settingsView.matchAll(/if \(result\.id === '([^']+)'\)\s*\{\s*return '([^']+)';/g)) {
      redirects.set(match[1], match[2]);
    }
    return redirects;
  };

  test('every search entry id has a settings-item anchor in the component sources', () => {
    const sources = readComponentSources();
    const anchors = new Set<string>([
      ...collectLiteralAnchors(sources),
      ...collectCatalogAnchors(sources),
      ...collectShortcutAnchors(sources),
    ]);
    const redirects = collectRedirects(sources);

    const { ids, idFields } = readSearchIndex();
    // Every `id:` field is a literal or the one shortcut construction. A new
    // entry that builds its id another way would slip past the anchor scan, so
    // it has to be taught here first.
    const unseenIdFields = idFields.filter(
      (field) => field !== 'shortcutSearchItemId(action.id)' && !/^'[^']+'$/.test(field),
    );
    expect(unseenIdFields).toEqual([]);
    // Every literal id plus one generated entry per in-app shortcut; a lower
    // count means the scan stopped seeing entries, not that the index shrank.
    expect(ids.length).toBeGreaterThan(250);

    const unanchored = ids.filter((id) => {
      if (anchors.has(id)) return false;
      const redirect = redirects.get(id);
      return !redirect || !anchors.has(redirect);
    });
    expect(unanchored).toEqual([]);
  });

  test('routing.token is pinned to Providers and its preparation opens the Classification gate (#1762)', () => {
    const searchSource = readFileSync(join(__dirname, 'search.ts'), 'utf-8');
    const entry = searchSource.match(/id: 'routing\.token',\s*page: '([^']+)'/);
    expect(entry?.[1]).toBe('providers');

    const sources = readComponentSources();
    const settingsView = sources.get(settingsViewPath) ?? '';
    // The token field renders only behind the Classification gate, so
    // prepareSettingsSearchTarget must request that sub-page for
    // routing.token itself — the global anchor test above cannot see a
    // wrong-page entry whose anchor exists on another page.
    expect(/result\.id === 'routing\.token'[\s\S]{0,240}setSettingsProvidersClassificationRequested\(true\)/.test(settingsView)).toBe(true);

    const classificationPage = [...sources.entries()]
      .find(([filePath]) => filePath.endsWith('ClassificationProvidersPage.tsx'))?.[1] ?? '';
    expect(classificationPage).toContain('settingsItem="routing.token"');
  });

  test('providers.custom is pinned to Providers and its preparation enters custom-create mode (#1765)', () => {
    const searchSource = readFileSync(join(__dirname, 'search.ts'), 'utf-8');
    const entry = searchSource.match(/id: 'providers\.custom',\s*page: '([^']+)'/);
    expect(entry?.[1]).toBe('providers');

    const sources = readComponentSources();
    const settingsView = sources.get(settingsViewPath) ?? '';
    // The anchored field renders only inside CustomProviderForm, which
    // the Providers page shows only in custom-create mode, so
    // prepareSettingsSearchTarget must request that mode for
    // providers.custom itself - the global anchor test above cannot see
    // an entry whose anchor exists but renders in a flow state its
    // result never enters.
    expect(/result\.id === 'providers\.custom'[\s\S]{0,240}setSettingsProvidersCustomRequested\(true\)/.test(settingsView)).toBe(true);

    const providersPage = [...sources.entries()]
      // The suffix must name the providers directory as well: plain
      // 'ProvidersPage.tsx' also matches ClassificationProvidersPage.tsx,
      // and which of the two the find returns depends on readdir order,
      // so the assertion passed or failed with the filesystem (#13655).
      .find(([filePath]) => /[\\/]providers[\\/]ProvidersPage\.tsx$/.test(filePath))?.[1] ?? '';
    // The page consumes the request by preselecting the custom candidate
    // in add mode (custom-create mode), then clears the one-shot flag.
    expect(/customRequested[\s\S]{0,400}setCandidateProviderId\(CUSTOM_PROVIDER_ID\)/.test(providersPage)).toBe(true);
    expect(providersPage).toContain('setCustomRequested(false)');

    const customForm = [...sources.entries()]
      .find(([filePath]) => filePath.endsWith('CustomProviderForm.tsx'))?.[1] ?? '';
    expect(customForm).toContain('settingsItem="providers.custom"');
  });
});
