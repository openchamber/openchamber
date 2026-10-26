import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { MovablePane } = await import('./MovablePane');
const { setZoneBody, useZoneHostsStore } = await import('./zoneHosts');

type Zone = 'left' | 'right' | 'bottom';

// Stands in for a keep-alive surface: counts its mounts and holds an edit
// that only survives if the component and its DOM do.
let mounts = 0;
const Surface: React.FC = () => {
  React.useEffect(() => {
    mounts += 1;
  }, []);
  return <input data-testid="draft" defaultValue="" />;
};

let container: HTMLElement;
let root: Root;
const bodies = {
  left: document.createElement('div'),
  right: document.createElement('div'),
  bottom: document.createElement('div'),
};

const render = async (zone: Zone | null) => {
  await act(async () => {
    root.render(zone ? <MovablePane zone={zone}><Surface /></MovablePane> : null);
  });
};

beforeEach(() => {
  mounts = 0;
  container = document.createElement('div');
  document.body.append(container);
  for (const zone of ['left', 'right', 'bottom'] as const) {
    bodies[zone].replaceChildren();
    document.body.append(bodies[zone]);
    setZoneBody(zone, bodies[zone]);
  }
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useZoneHostsStore.setState({ body: { left: null, right: null, bottom: null } });
  document.body.innerHTML = '';
});

describe('MovablePane', () => {
  test('moving to another zone keeps the same component and its uncommitted edit', async () => {
    await render('right');
    const input = bodies.right.querySelector('input');
    expect(input).not.toBeNull();
    if (input) input.value = 'unsaved';

    await render('left');
    expect(bodies.right.querySelector('input')).toBeNull();
    expect(bodies.left.querySelector('input')).toBe(input);
    expect(input?.value).toBe('unsaved');

    await render('bottom');
    expect(bodies.bottom.querySelector('input')).toBe(input);
    expect(mounts).toBe(1);
  });

  test('a zone whose body appears later receives the pane then', async () => {
    setZoneBody('left', null);
    await render('left');
    expect(document.querySelector('input')?.isConnected ?? false).toBe(false);

    await act(async () => setZoneBody('left', bodies.left));
    expect(bodies.left.querySelector('input')).not.toBeNull();
  });

  test('unmounting takes the pane out of its zone', async () => {
    await render('right');
    await render(null);
    expect(bodies.right.childElementCount).toBe(0);
  });
});
