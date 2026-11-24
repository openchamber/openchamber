import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { RoutingConfig } from '@/lib/routing/routingApi';
import { useFallbackPrefill } from './useFallbackPrefill';

const DEFAULT_MODEL = 'opencode/big-pickle';
const PREFILLED = { model: { providerID: 'opencode', modelID: 'big-pickle' }, variant: null };

const config = (fallback: RoutingConfig['fallback']): RoutingConfig => ({
  enabled: true,
  fallback,
  minConfidence: 0.5,
  safetyNet: { enabled: false, threshold: 0.5 },
  categories: [],
});

const STORED_FALLBACK = config({ model: { providerID: 'anthropic', modelID: 'claude-sonnet' }, variant: null });

describe('useFallbackPrefill', () => {
  let root: Root;
  let host: HTMLElement;
  let updates: Array<RoutingConfig['fallback']>;

  const Probe: React.FC<{
    serverConfig: RoutingConfig;
    defaultModel?: string;
    onReady?: (choose: (providerID: string, modelID: string) => void) => void;
  }> = ({ serverConfig, defaultModel = DEFAULT_MODEL, onReady }) => {
    const choose = useFallbackPrefill(true, serverConfig, defaultModel, null, (mutate: (config: RoutingConfig) => RoutingConfig) => {
      updates.push(mutate(serverConfig).fallback);
    });
    onReady?.(choose);
    return null;
  };

  beforeEach(() => {
    const windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    updates = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  test('fills an empty fallback with the default model on the first load', async () => {
    await act(async () => root.render(<Probe serverConfig={config(null)} />));
    expect(updates).toEqual([PREFILLED]);
  });

  test('leaves an unset fallback unset when the page loaded with one', async () => {
    await act(async () => root.render(<Probe serverConfig={STORED_FALLBACK} />));
    await act(async () => root.render(<Probe serverConfig={config(null)} />));
    expect(updates).toEqual([]);
  });

  test('picking no fallback before the default model arrives keeps it unset', async () => {
    let choose: (providerID: string, modelID: string) => void = () => {};
    await act(async () => root.render(<Probe serverConfig={config(null)} defaultModel="" onReady={(c) => { choose = c; }} />));
    expect(updates).toEqual([]);
    await act(async () => choose('', ''));
    expect(updates).toEqual([null]);
    await act(async () => root.render(<Probe serverConfig={config(null)} defaultModel={DEFAULT_MODEL} />));
    expect(updates).toEqual([null]);
  });

  test('a fresh mount with a default model prefills again', async () => {
    let choose: (providerID: string, modelID: string) => void = () => {};
    await act(async () => root.render(<Probe serverConfig={config(null)} defaultModel="" onReady={(c) => { choose = c; }} />));
    await act(async () => choose('', ''));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Probe serverConfig={config(null)} />));
    expect(updates).toEqual([null, PREFILLED]);
  });
});
