import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeVoiceKeys, readVoiceKey, updateVoiceKeys } from './voice-keys.js';

describe('voice keys store', () => {
  let dataDir;
  let previousDataDir;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-voice-keys-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps keys in an owner-only file and answers only whether each is set', () => {
    expect(updateVoiceKeys({ openai: ' sk-openai ', stt: 'sk-stt' })).toEqual({ openai: true, openaiCompatible: false, stt: true });
    expect(readVoiceKey('openai')).toBe('sk-openai');
    expect(JSON.stringify(describeVoiceKeys())).not.toContain('sk-');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'voice-keys.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('removes a key on null and leaves the others alone', () => {
    updateVoiceKeys({ openai: 'sk-openai', openaiCompatible: 'sk-compat' });
    expect(updateVoiceKeys({ openai: null })).toEqual({ openai: false, openaiCompatible: true, stt: false });
    expect(readVoiceKey('openaiCompatible')).toBe('sk-compat');
  });

  it('refuses a malformed patch without touching what is stored', () => {
    updateVoiceKeys({ openai: 'sk-openai' });
    expect(() => updateVoiceKeys({ openai: 42 })).toThrow();
    expect(() => updateVoiceKeys({ somethingElse: 'x' })).toThrow();
    expect(readVoiceKey('openai')).toBe('sk-openai');
  });
});
