import { describe, expect, test } from 'bun:test';
import type { I18nKey, I18nParams } from '@/lib/i18n/store';
import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { buildSettingsSearchResults } from './search';
import { useConfigStore } from '@/stores/useConfigStore';
import { dict as ukDict } from '@/lib/i18n/messages/uk';

const trackers = [linearLikeTrackerDescriptor()];
const sourceControlProviders = [githubLikeDescriptor(), gitlabLikeDescriptor()];

const t = (key: I18nKey, params?: I18nParams): string => (params ? `${key} ${JSON.stringify(params)}` : key);

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
};

describe('settings search', () => {
  test('indexes the retention target under its current label and existing anchor', () => {
    const results = buildSettingsSearchResults({ query: 'retention', runtimeCtx, t, getPageTitle: (page) => page });
    const target = results.find((result) => result.id === 'sessions.retention-only-archived');
    expect(target?.page).toBe('sessions');
    expect(target?.title).toBe('settings.layout.sessions.retention.target');
    expect(target?.description).toBeNull();
  });

  test('finds localized endpoint fields only while their controls are visible', () => {
    const initial = useConfigStore.getState();
    try {
      for (const context of [runtimeCtx, { ...runtimeCtx, isDesktop: true }, { ...runtimeCtx, isMobile: true }, { ...runtimeCtx, isVSCode: true }]) {
        for (const enabled of [false, true]) {
          for (const custom of [false, true]) {
            useConfigStore.setState({
              voiceProvider: custom ? 'openai-compatible' : 'local',
              sttProvider: custom ? 'openai-compatible' : 'local',
              showMessageTTSButtons: enabled,
              autoReadAloudEnabled: false,
              dictationEnabled: enabled,
            });
            for (const query of ['endpoint path', 'custom endpoint', 'resource path', ukDict['settings.voice.page.field.endpointPath']]) {
              const results = buildSettingsSearchResults({ query, runtimeCtx: context, t: (key) => ukDict[key], getPageTitle: (page) => page });
              const ids = results.map((result) => result.id);
              expect(ids.includes('voice.tts-endpoint-path')).toBe(enabled && custom && !context.isVSCode);
              expect(ids.includes('voice.stt-endpoint-path')).toBe(enabled && custom && !context.isVSCode);
            }
          }
        }
      }
      useConfigStore.setState({ voiceProvider: 'openai-compatible', showMessageTTSButtons: false, autoReadAloudEnabled: true });
      expect(buildSettingsSearchResults({ query: 'endpoint path', runtimeCtx, t, getPageTitle: (page) => page })
        .some((result) => result.id === 'voice.tts-endpoint-path')).toBe(true);
    } finally {
      useConfigStore.setState(initial);
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
  test('finds Linear connect on the integrations page when the server serves Linear', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
      trackers,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(true);

    const withoutLinear = buildSettingsSearchResults({ query: 'linear', runtimeCtx, t, getPageTitle: (page) => page, trackers: [] });
    expect(withoutLinear.some((result) => result.id.startsWith('integrations.linear'))).toBe(false);
  });

  test('offers only what a tracker\'s capabilities have, and nothing for a tracker without words of its own', () => {
    const single = linearLikeTrackerDescriptor({
      capabilities: { ...linearLikeTrackerDescriptor().capabilities, multipleAccounts: false, projectMapping: false },
    });
    const results = buildSettingsSearchResults({ query: 'linear', runtimeCtx, t, getPageTitle: (page) => page, trackers: [single, acmeTrackerDescriptor()] });
    expect(results.filter((result) => result.id.startsWith('integrations.linear')).map((result) => result.id)).toEqual(['integrations.linear']);
    const acme = buildSettingsSearchResults({ query: 'acme', runtimeCtx, t, getPageTitle: (page) => page, trackers: [acmeTrackerDescriptor()] });
    expect(acme.some((result) => result.id.startsWith('integrations.acme'))).toBe(false);
  });

  test('finds the small model effort setting by thinking and reasoning keywords', () => {
    for (const query of ['small model effort', 'small model thinking', 'small model variant']) {
      const results = buildSettingsSearchResults({
        query,
        runtimeCtx,
        t,
        getPageTitle: (page) => page,
      });
      expect(results.some((result) => result.id === 'sessions.small-model')).toBe(true);
    }
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
      trackers,
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
      sourceControlProviders,
    });
    expect(connectResults.some((result) => result.id === 'integrations.source-control.github.connect')).toBe(true);
    expect(connectResults.some((result) => result.id === 'integrations.source-control.gitlab.connect')).toBe(true);
  });

  test('builds a card and a connect entry for every served source-control provider, named by its label', () => {
    const results = buildSettingsSearchResults({
      query: 'acme',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
      sourceControlProviders: [...sourceControlProviders, acmeDescriptor()],
    });
    expect(results.map((result) => result.id)).toEqual([
      'integrations.source-control.acme',
      'integrations.source-control.acme.connect',
    ]);
    expect(results[0]?.title).toBe('Acme Forge');
    expect(results[0]?.description).toContain('"provider":"Acme Forge"');
    expect(results[1]?.title).toContain('"provider":"Acme Forge"');

    const byNoun = buildSettingsSearchResults({ query: 'merge request', runtimeCtx, t, getPageTitle: (page) => page, sourceControlProviders });
    expect(byNoun.some((result) => result.id === 'integrations.source-control.gitlab')).toBe(true);
    expect(byNoun.some((result) => result.id === 'integrations.source-control.github')).toBe(false);

    const unserved = buildSettingsSearchResults({ query: 'gitlab', runtimeCtx, t, getPageTitle: (page) => page });
    expect(unserved.some((result) => result.id.startsWith('integrations.source-control.'))).toBe(false);
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
      sourceControlProviders,
    });

    expect(transportResults.some((result) => result.id === 'git.repository-transport')).toBe(false);
    expect(accountResults.some((result) => result.id.startsWith('integrations.source-control.'))).toBe(false);
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
});
