import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { I18nProvider } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as de } from '@/lib/i18n/messages/de';
import { dict as es } from '@/lib/i18n/messages/es';
import { dict as fr } from '@/lib/i18n/messages/fr';
import { dict as ja } from '@/lib/i18n/messages/ja';
import { dict as ko } from '@/lib/i18n/messages/ko';
import { dict as pl } from '@/lib/i18n/messages/pl';
import { dict as ptBR } from '@/lib/i18n/messages/pt-BR';
import { dict as uk } from '@/lib/i18n/messages/uk';
import { dict as zhCN } from '@/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '@/lib/i18n/messages/zh-TW';
import { GitOperationStatus } from './GitOperationStatus';
import type { GitActionRecovery } from './useGitOperationRecovery';

const entry: GitActionRecovery = {
  localCommit: true, executing: false, checking: false,
  reads: [{ runtimeKey: 'runtime-a', availability: 'available', operation: {
    operationId: 'git_original', runtimeIdentity: { id: 'server-a', platform: 'web' },
    transport: { fetch: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } }, push: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } } },
    target: { operation: 'sync', repositoryId: 'repo-a', bindingRevision: 1, configRevision: 'config-a',
      fetch: { name: 'origin', endpoint: { displayUrl: 'https://example.com/repo.git', fingerprint: 'fetch' }, sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/origin/main' },
      pull: { destinationRef: 'refs/heads/main' },
      push: { name: 'origin', endpoint: { displayUrl: 'https://example.com/repo.git', fingerprint: 'push' }, sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main' },
    },
    state: 'partial', error: { code: 'TRANSPORT_FAILED', message: 'Push rejected' },
    completedSteps: ['transferred', 'updated-local-repository'],
    stepResults: [{ step: 'fetch', status: 'succeeded' }, { step: 'pull', status: 'succeeded' }, { step: 'push', status: 'failed' }],
  } }],
};
const render = (entry: GitActionRecovery) => renderToStaticMarkup(<I18nProvider><GitOperationStatus entry={entry} onRefresh={() => {}} onCancel={() => {}} /></I18nProvider>);

describe('Git operation feedback', () => {
  test('a restored reference shows uncertainty, never planned or running history', () => {
    const html = render({ reads: [], localCommit: false, executing: false, checking: true, problem: 'reconciling', pending: [{
      runtimeKey: 'a'.repeat(64), runtimeIdentity: { id: 'server-a', platform: 'web' }, repositoryId: 'repo-a',
      operationId: 'git_saved', operation: 'push', targetDigest: 'b'.repeat(64),
    }] });
    expect(html).toContain('git_saved');
    expect(html).toContain('Operation status unavailable');
    expect(html).toContain('Checking saved Git operation references');
    expect(html).not.toContain('Running');
    expect(html).not.toContain('Planned');
    expect(html).not.toContain('Cancel operation');
  });
  test('renders the retained commit, completed local steps and partial result without a replay control', () => {
    const html = render(entry);
    for (const text of ['git_original', 'Partially completed', 'Fetch', 'Pull', 'Push', 'Local repository updated', 'The local commit was created and is retained.']) expect(html).toContain(text);
    expect(html).not.toContain('Cancel operation');
    expect(html).not.toContain('Retry');
    expect(html).toContain('aria-live="polite"');
  });

  test('unavailable active operations expose Refresh and Cancel, not a definite failed result', () => {
    const operation = { ...entry.reads[0].operation, state: 'running' as const };
    const html = render({ ...entry, reads: [{ ...entry.reads[0], operation, availability: 'unavailable' }] });
    expect(html).toContain('Operation status unavailable');
    expect(html).toContain('The outcome is unknown.');
    expect(html).toContain('Refresh operation');
    expect(html).toContain('Cancel operation');
    expect(html).not.toContain('Partially completed');
  });

  test('renders bounded hydration details with the redacted endpoint', () => {
    const operation = {
      operationId: 'git_hydration', runtimeIdentity: { id: 'server-a', platform: 'web' as const },
      transport: { mode: 'anonymous' as const, verification: { status: 'anonymous' as const } },
      target: {
        operation: 'checkout-hydration' as const, repositoryId: 'repo-a', bindingRevision: 1,
        configRevision: 'config-a', remote: { name: 'origin', endpoint: { displayUrl: 'https://example.com/repo.git', fingerprint: 'parent' } },
        requirements: [{ kind: 'submodule' as const, path: 'vendor/module', endpoint: { displayUrl: 'https://modules.example/module.git', fingerprint: 'module' } }],
      },
      state: 'failed' as const, completedSteps: ['validated' as const],
      error: { code: 'AUTHENTICATION_REQUIRED' as const, message: 'Grant required' },
      hydration: {
        status: 'authorization-required' as const,
        submodules: [{
          path: 'vendor/module', status: 'authorization-required' as const,
          endpoint: { displayUrl: 'https://modules.example/module.git', fingerprint: 'module' },
          error: { code: 'AUTHENTICATION_REQUIRED' as const, message: 'Grant required' },
        }],
        lfs: [],
      },
    };
    const html = render({ reads: [{ runtimeKey: 'runtime-a', availability: 'available', operation }], localCommit: false, executing: false, checking: false });
    expect(html).toContain('vendor/module');
    expect(html).toContain('Submodule');
    expect(html).toContain('Authorization required');
    expect(html).toContain('https://modules.example/module.git');
  });

  test('all 11 shipped dictionaries contain translated operation feedback', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('gitView.operation.'));
    for (const dictionary of [de, es, fr, ja, ko, pl, ptBR, uk, zhCN, zhTW]) {
      const translated = new Map(Object.entries(dictionary));
      for (const key of keys) expect(translated.get(key)).toBeTruthy();
      expect(dictionary['gitView.operation.unknownHint']).not.toBe(en['gitView.operation.unknownHint']);
      expect(dictionary['gitView.operation.localCommit']).not.toBe(en['gitView.operation.localCommit']);
    }
  });
});
