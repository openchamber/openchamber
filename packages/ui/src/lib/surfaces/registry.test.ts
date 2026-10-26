import { describe, expect, test } from 'bun:test';

import {
  CONTEXT_SURFACES,
  getVisibleContextRailSurfaces,
  WALKTHROUGH_MIN_WIDTH,
} from './registry';

const baseOptions = {
  railOrder: [],
  isVSCode: false,
  screenWidth: 1200,
  tabs: [],
  sourceControlConnected: true,
  workflowsShown: false,
} as const;

describe('getVisibleContextRailSurfaces', () => {
  test('hides the walkthrough on VS Code and below the min width', () => {
    expect(getVisibleContextRailSurfaces({ ...baseOptions, isVSCode: true }).some((s) => s.id === 'walkthrough')).toBe(false);
    expect(
      getVisibleContextRailSurfaces({ ...baseOptions, screenWidth: WALKTHROUGH_MIN_WIDTH - 1 }).some((s) => s.id === 'walkthrough'),
    ).toBe(false);
    expect(
      getVisibleContextRailSurfaces({ ...baseOptions, screenWidth: WALKTHROUGH_MIN_WIDTH }).some((s) => s.id === 'walkthrough'),
    ).toBe(true);
  });

  test('offers no browser surface inside VS Code', () => {
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'browser')).toBe(true);
    // Nothing that makes the panel worth having works there, so offering it
    // would promise the panel people see on the desktop.
    expect(getVisibleContextRailSurfaces({ ...baseOptions, isVSCode: true }).some((s) => s.id === 'browser')).toBe(false);
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

  test('respects the persisted user rail order', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, railOrder: ['git', 'context'] });
    expect(surfaces.slice(0, 2).map((surface) => surface.id)).toEqual(['git', 'context']);
  });

  test('hides the Tracker until a repository host is connected or an item is open in it', () => {
    expect(getVisibleContextRailSurfaces({ ...baseOptions, sourceControlConnected: false }).some((s) => s.id === 'pr')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, sourceControlConnected: true }).some((s) => s.id === 'pr')).toBe(true);
    const tabs: { mode: 'pr'; targetPath: string }[] = [{ mode: 'pr', targetPath: 'https://linear.app/acme/issue/ENG-7' }];
    expect(getVisibleContextRailSurfaces({ ...baseOptions, sourceControlConnected: false, tabs }).some((s) => s.id === 'pr')).toBe(true);
  });

  test('offers Workflows only while the caller says so, and never in VS Code', () => {
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'workflows')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, workflowsShown: true }).some((s) => s.id === 'workflows')).toBe(true);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, workflowsShown: true, isVSCode: true }).some((s) => s.id === 'workflows')).toBe(false);
  });

  test('appends installed guest panels except on VS Code', () => {
    const hello = {
      id: 'plugin:hello' as const,
      mode: 'plugin:hello' as const,
      icon: 'window' as const,
      label: 'Hello',
      labelKey: 'contextRail.surface.plugin' as const,
      descriptionKey: 'contextRail.surface.plugin.description' as const,
      availability: 'always' as const,
    };
    expect(getVisibleContextRailSurfaces({ ...baseOptions, extras: [hello] }).some((s) => s.id === 'plugin:hello')).toBe(true);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, extras: [hello], isVSCode: true }).some((s) => s.id === 'plugin:hello')).toBe(false);
  });
});
