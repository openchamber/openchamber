import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-model-settings-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const { readWalkthroughModelOverride } = await import('./model-settings.js');

const SETTINGS_FILE = path.join(TEMP_DATA_DIR, 'settings.json');

const write = (value) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(value), 'utf8');

describe('readWalkthroughModelOverride', () => {
  beforeEach(() => {
    fs.rmSync(SETTINGS_FILE, { force: true });
  });

  it('returns the chosen model', () => {
    write({ walkthroughModelOverride: 'anthropic/claude-haiku-4-5' });
    expect(readWalkthroughModelOverride()).toBe('anthropic/claude-haiku-4-5');
  });

  it('defers to the small model when nothing is chosen', () => {
    write({});
    expect(readWalkthroughModelOverride()).toBeNull();

    // Clearing the picker writes an empty string; that must read as "use the
    // small model", not as an override of ''.
    write({ walkthroughModelOverride: '' });
    expect(readWalkthroughModelOverride()).toBeNull();

    write({ walkthroughModelOverride: '   ' });
    expect(readWalkthroughModelOverride()).toBeNull();
  });

  it('never throws on a missing or corrupt settings file', () => {
    expect(readWalkthroughModelOverride()).toBeNull();

    fs.writeFileSync(SETTINGS_FILE, '{ not json', 'utf8');
    expect(readWalkthroughModelOverride()).toBeNull();
  });

  it('is independent of the small model override', () => {
    write({
      smallModelUseDefault: false,
      smallModelOverride: 'google/gemini-2.5-flash',
      walkthroughModelOverride: 'anthropic/claude-haiku-4-5',
    });

    expect(readWalkthroughModelOverride()).toBe('anthropic/claude-haiku-4-5');
  });
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});
