import { describe, expect, test } from 'bun:test';
import { GUEST_SCROLLBAR_CSS } from '../scrollbar-style.ts';
import { GUEST_UI_LOOK_CSS, UI_CSS } from './style.ts';

/** Every `property:` inside the rule blocks of a stylesheet. */
const declaredProperties = (css: string): Set<string> => new Set(
  [...css.matchAll(/[{;]\s*(-{0,2}[a-z][a-z-]*)\s*:/g)].map((match) => match[1] ?? ''),
);

describe('UI kit styles', () => {
  test('the look the host serves leaves geometry to the bundle', () => {
    // The host appends this sheet to installed bundles, so a size in it would move their layouts without a rebuild.
    const geometry = /^(?:(?:min-|max-)?(?:width|height)|padding.*|margin.*|gap|font-size|font-weight|line-height|display|position|inset|top|right|bottom|left|flex.*|overflow)$/;
    expect([...declaredProperties(GUEST_UI_LOOK_CSS)].filter((name) => geometry.test(name))).toEqual([]);
  });

  test('a raised control with a border draws its hairline as that border', () => {
    // An inset ring paints inside the 1px border, so the line would sit 1px in from the control's edge.
    const rules = [
      '.oc-sdk-btn[data-variant="outline"] {',
      '.oc-sdk-trigger {',
      '.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] {',
    ].map((selector) => GUEST_UI_LOOK_CSS.split('\n').find((line) => line.startsWith(selector)) ?? '');
    for (const rule of rules) {
      expect(rule).toContain('border-color: var(--oc-sdk-edge)');
      expect(rule).not.toContain('inset 0 0 0 1px');
    }
    expect(GUEST_UI_LOOK_CSS).toMatch(/\.oc-sdk-popup \{[^}]*border-color: var\(--oc-sdk-float-edge\)/);
  });

  test('the kit ships scrollbars, its sizes and the look', () => {
    expect(UI_CSS).toContain(GUEST_SCROLLBAR_CSS);
    expect(UI_CSS).toContain(GUEST_UI_LOOK_CSS);
    expect(UI_CSS).toContain('.oc-sdk-btn { display: inline-flex;');
  });
});
