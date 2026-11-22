import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { invalidateSettingsCache } from './persistence';
import { fetchResponseStyleInstruction, getResponseStylePresetInstructions, type ResponseStylePreset } from './responseStyle';

// The instruction comes from the server's settings document, read for the
// send: a style changed on another device applies from the next message once
// this window's short read cache (2 s) has expired, without any save here.

const settingsDocument = (preset: ResponseStylePreset) => ({ responseStyleEnabled: true, responseStylePreset: preset });
let served = settingsDocument('concise');
let reads = 0;
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

const settle = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

beforeAll(() => {
  const serve = async () => {
    reads += 1;
    return new Response(JSON.stringify(served), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  Object.defineProperty(globalThis, 'fetch', { value: serve, configurable: true, writable: true });
  invalidateSettingsCache();
});

afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  invalidateSettingsCache();
});

describe('fetchResponseStyleInstruction', () => {
  test('follows a style changed on another device once the read cache expired', async () => {
    expect(await fetchResponseStyleInstruction()).toBe(getResponseStylePresetInstructions('concise'));
    expect(reads).toBe(1);

    served = settingsDocument('detailed');
    // Within the cache window the known document answers.
    expect(await fetchResponseStyleInstruction()).toBe(getResponseStylePresetInstructions('concise'));
    expect(reads).toBe(1);

    await settle(2_100);
    expect(await fetchResponseStyleInstruction()).toBe(getResponseStylePresetInstructions('detailed'));
    expect(reads).toBe(2);
  }, 10_000);
});
