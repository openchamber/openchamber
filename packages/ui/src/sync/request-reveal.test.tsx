import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { revealRequest, useRequestReveal } from './request-reveal';

describe('revealing a request from its toast', () => {
  let root: Root;
  let revealed: Array<[string, string]>;
  const globals = new Map<string, PropertyDescriptor | undefined>();

  const Dock = ({ name, ids }: { name: string; ids: string[] }) => {
    useRequestReveal(ids, React.useCallback((id: string) => { revealed.push([name, id]); }, [name]));
    return null;
  };
  const render = async (node: React.ReactNode) => {
    await act(async () => { root.render(node); });
  };
  const reveal = async (id: string) => {
    await act(async () => { revealRequest(id); });
  };

  beforeEach(() => {
    revealed = [];
    const window = new Window({ url: 'http://localhost/' });
    for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  test('only the dock holding the request reveals it, once', async () => {
    await render(<><Dock name="forms" ids={['form-1', 'form-2']} /><Dock name="permissions" ids={['perm-1']} /></>);

    await reveal('form-2');
    expect(revealed).toEqual([['forms', 'form-2']]);

    // A later render does not reveal it again.
    await render(<><Dock name="forms" ids={['form-1', 'form-2']} /><Dock name="permissions" ids={['perm-1']} /></>);
    expect(revealed).toEqual([['forms', 'form-2']]);

    // The same toast clicked again after the user collapsed the dock once more.
    await reveal('form-2');
    expect(revealed).toEqual([['forms', 'form-2'], ['forms', 'form-2']]);
  });

  test('a dock that receives the request after the session switch still reveals it', async () => {
    await render(<Dock name="permissions" ids={['perm-a']} />);

    await reveal('perm-b');
    expect(revealed).toEqual([]);

    await render(<Dock name="permissions" ids={['perm-b']} />);
    expect(revealed).toEqual([['permissions', 'perm-b']]);
  });
});
