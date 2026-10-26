import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { GlassRedrawGuard } = await import('./glass-redraw-guard');

const guarded = () => document.documentElement.hasAttribute('data-glass-redraw-guard');

describe('GlassRedrawGuard', () => {
  afterAll(() => browser.close());

  test('holds the attribute until the last open popup closes', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (menu: boolean, tooltip: boolean) => act(() => {
      root.render(
        <>
          {menu ? <GlassRedrawGuard /> : null}
          {tooltip ? <GlassRedrawGuard /> : null}
        </>,
      );
    });

    expect(guarded()).toBe(false);
    render(true, false);
    expect(guarded()).toBe(true);
    render(true, true);
    render(true, false);
    // The tooltip closed beside the still-open menu: the layer stays.
    expect(guarded()).toBe(true);
    render(false, false);
    expect(guarded()).toBe(false);

    act(() => root.unmount());
    host.remove();
  });
});
