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

  test('hides content-driven surfaces until a matching tab exists', () => {
    const preview = CONTEXT_SURFACES.find((surface) => surface.id === 'preview');
    if (!preview) {
      throw new Error('preview surface missing from registry');
    }
    expect(preview.availability).toBe('has-content');
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'preview')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, tabs: [{ mode: preview.mode }] }).some((s) => s.id === 'preview')).toBe(true);
  });

  test('respects the persisted user rail order', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, railOrder: ['git', 'context'] });
    expect(surfaces.slice(0, 2).map((surface) => surface.id)).toEqual(['git', 'context']);
  });
});
