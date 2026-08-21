import React from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { DEFAULT_GIT_REPOSITORY_PANE_STATE, useUIStore } from '@/stores/useUIStore';
import { GitWorkspacePanes } from './GitWorkspacePanes';
import { clampGitGraphPaneHeight } from './gitWorkspacePanesModel';

const directory = '/repo';

const renderPanesMarkup = () => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    null,
    React.createElement(GitWorkspacePanes, {
      directory,
      changes: React.createElement('div', null, 'changes'),
      commit: React.createElement('div', null, 'commit'),
      graph: React.createElement('div', null, 'graph'),
      graphHeaderControls: React.createElement('span', { 'data-graph-header-controls': 'true' }, 'controls'),
    }),
  ),
);

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
    const markup = renderPanesMarkup();

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('cursor-row-resize');
    expect(markup.match(/data-git-resize-handle/g)?.length ?? 0).toBe(1);
    expect(markup.match(/data-git-resize-dot/g)?.length ?? 0).toBe(3);
  });

  test('renders expanded graph header controls outside the collapse button only while expanded', () => {
    const originalGraphCollapsed = DEFAULT_GIT_REPOSITORY_PANE_STATE.graphCollapsed;

    DEFAULT_GIT_REPOSITORY_PANE_STATE.graphCollapsed = false;
    const expandedMarkup = renderPanesMarkup();
    DEFAULT_GIT_REPOSITORY_PANE_STATE.graphCollapsed = true;
    const collapsedMarkup = renderPanesMarkup();
    DEFAULT_GIT_REPOSITORY_PANE_STATE.graphCollapsed = originalGraphCollapsed;

    expect(expandedMarkup).toContain('data-graph-header-controls="true"');
    expect(expandedMarkup.indexOf('data-graph-header-controls="true"')).toBeGreaterThan(expandedMarkup.indexOf('</button>'));
    expect(collapsedMarkup).not.toContain('data-graph-header-controls="true"');
  });

  test('renders the changes pane body as a fill-height flex column', () => {
    const markup = renderPanesMarkup();

    expect(markup).toContain('id="git-changes-pane-body" class="min-h-0 flex-1 flex flex-col"');
  });
});
