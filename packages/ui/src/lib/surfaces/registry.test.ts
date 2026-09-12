import { describe, expect, test } from 'bun:test';

import {
  CONTEXT_SURFACES,
  getVisibleContextRailSurfaces,
  WALKTHROUGH_MIN_WIDTH,
} from './registry';

const baseOptions = {
  railOrder: [],
  planModeEnabled: true,
  serverBrowserEnabled: true,
  isVSCode: false,
  screenWidth: 1200,
  tabs: [],
  linearConnected: true,
  githubConnected: true,
} as const;

describe('getVisibleContextRailSurfaces', () => {
  test('hides the plan surface while plan mode is disabled', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, planModeEnabled: false });
    expect(surfaces.some((surface) => surface.id === 'plan')).toBe(false);
    expect(surfaces.some((surface) => surface.id === 'context')).toBe(true);
  });

  test('shows the plan surface while plan mode is enabled', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, planModeEnabled: true });
    expect(surfaces.some((surface) => surface.id === 'plan')).toBe(true);
  });

  test('hides the walkthrough on VS Code and below the min width', () => {
    expect(getVisibleContextRailSurfaces({ ...baseOptions, isVSCode: true }).some((s) => s.id === 'walkthrough')).toBe(false);
    expect(
      getVisibleContextRailSurfaces({ ...baseOptions, screenWidth: WALKTHROUGH_MIN_WIDTH - 1 }).some((s) => s.id === 'walkthrough'),
    ).toBe(false);
    expect(
      getVisibleContextRailSurfaces({ ...baseOptions, screenWidth: WALKTHROUGH_MIN_WIDTH }).some((s) => s.id === 'walkthrough'),
    ).toBe(true);
  });

  test('keeps local and server browsers distinct and offers neither inside VS Code', () => {
    const browser = CONTEXT_SURFACES.find((surface) => surface.id === 'browser');
    const serverBrowser = CONTEXT_SURFACES.find((surface) => surface.id === 'server-browser');
    expect(browser?.mode).toBe('browser');
    expect(browser?.icon).toBe('global');
    expect(serverBrowser?.mode).toBe('server-browser');
    expect(serverBrowser?.icon).toBe('server');
    expect(serverBrowser?.labelKey).toBe('contextPanel.browser.remote.tabLabel');
    expect(serverBrowser?.descriptionKey).toBe('contextRail.surface.server-browser.description');
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'browser')).toBe(true);
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'server-browser')).toBe(true);
    // Nothing that makes the panel worth having works there, so offering it
    // would promise the panel people see on the desktop.
    expect(getVisibleContextRailSurfaces({ ...baseOptions, isVSCode: true }).some((s) => s.id === 'browser')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, isVSCode: true }).some((s) => s.id === 'server-browser')).toBe(false);
  });

  test('hides content-driven surfaces until a matching tab exists', () => {
    const chat = CONTEXT_SURFACES.find((surface) => surface.id === 'chat');
    if (!chat) {
      throw new Error('chat surface missing from registry');
    }
    expect(chat.availability).toBe('has-content');
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'chat')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, tabs: [{ mode: chat.mode }] }).some((s) => s.id === 'chat')).toBe(true);
  });

  test('the browser surface can be opened from the rail with no tab yet', () => {
    const browser = CONTEXT_SURFACES.find((surface) => surface.id === 'browser');
    expect(browser?.availability).toBe('always');
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'browser')).toBe(true);
  });

  test('shows the server browser only when the feature is enabled', () => {
    expect(getVisibleContextRailSurfaces({ ...baseOptions, serverBrowserEnabled: false }).some((s) => s.id === 'server-browser')).toBe(false);
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'server-browser')).toBe(true);
  });

  test('keeps server-browser visibility and user order independent from Browser', () => {
    const surfaces = getVisibleContextRailSurfaces({
      ...baseOptions,
      railOrder: ['server-browser', 'browser'],
      hiddenSurfaces: ['browser'],
    });
    expect(surfaces[0]?.id).toBe('server-browser');
    expect(surfaces.some((surface) => surface.id === 'browser')).toBe(false);
  });

  test('respects the persisted user rail order', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, railOrder: ['git', 'context'] });
    expect(surfaces.slice(0, 2).map((surface) => surface.id)).toEqual(['git', 'context']);
  });

  test('places Linear right after the walkthrough in the default order', () => {
    const ids = getVisibleContextRailSurfaces(baseOptions).map((surface) => surface.id);
    const walkthrough = ids.indexOf('walkthrough');
    expect(walkthrough).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('linear')).toBe(walkthrough + 1);
  });

  test('hides the pull request surface until GitHub is connected', () => {
    expect(getVisibleContextRailSurfaces({ ...baseOptions, githubConnected: false }).some((s) => s.id === 'pr')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, githubConnected: true }).some((s) => s.id === 'pr')).toBe(true);
  });

  test('hides Linear until a workspace is connected', () => {
    expect(getVisibleContextRailSurfaces({ ...baseOptions, linearConnected: false }).some((s) => s.id === 'linear')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, linearConnected: true }).some((s) => s.id === 'linear')).toBe(true);
  });
});
