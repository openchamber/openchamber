import { describe, expect, test } from 'bun:test';

import {
  CONTEXT_SURFACES,
  getVisibleContextRailSurfaces,
  WALKTHROUGH_MIN_WIDTH,
} from './registry';

const baseOptions = {
  railOrder: [],
  planModeEnabled: true,
  isVSCode: false,
  screenWidth: 1200,
  tabs: [],
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
});
