import React from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { GitWorkspacePanes } from './GitWorkspacePanes';
import { clampGitGraphPaneHeight } from './gitWorkspacePanesModel';

beforeEach(() => {
  useUIStore.setState({ gitRepositoryPaneStates: {} });
});

describe('GitWorkspacePanes helpers', () => {
  test('clamps graph pane height to supported bounds', () => {
    expect(clampGitGraphPaneHeight(10)).toBe(180);
    expect(clampGitGraphPaneHeight(280)).toBe(280);
    expect(clampGitGraphPaneHeight(999)).toBe(720);
  });

  test('renders a horizontal resize handle with a three-dot grip', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(GitWorkspacePanes, {
          directory: '/repo',
          changes: React.createElement('div', null, 'changes'),
          commit: React.createElement('div', null, 'commit'),
          graph: React.createElement('div', null, 'graph'),
        }),
      ),
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('cursor-col-resize');
    expect(markup.match(/data-git-resize-handle/g)?.length ?? 0).toBe(1);
    expect(markup.match(/data-git-resize-dot/g)?.length ?? 0).toBe(3);
  });
});
