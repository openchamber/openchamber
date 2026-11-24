import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveSpeechServer, describeVoiceKeys, readSpeechServerKey, readVoiceKey, updateVoiceKeys } from './voice-keys.js';

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

  const keysFile = () => path.join(dataDir, 'voice-keys.json');
  const SERVER = 'https://tts.example.com:8443/v1';

  it('reads a file from before approvals, and one with damaged approvals, as approving no server', () => {
    for (const origins of [undefined, 'https://tts.example.com:8443', [7], null, ['https://tts.example.com:8443', 'tts'], ['https://tts.example.com:8443', 'https://tts.example.com/v1']]) {
      fs.writeFileSync(keysFile(), JSON.stringify({ openaiCompatible: 'sk-compat', stt: 'sk-stt', openaiCompatibleOrigins: origins }));
      expect(readVoiceKey('openaiCompatible')).toBe('sk-compat');
      expect(readVoiceKey('stt')).toBe('sk-stt');
      expect(readSpeechServerKey(SERVER)).toEqual({ keyId: expect.any(String), approvedKey: undefined });
    }
    fs.writeFileSync(keysFile(), '{');
    expect(readSpeechServerKey(SERVER)).toBeNull();
    expect(updateVoiceKeys({ openaiCompatible: 'sk-new' }, SERVER).openaiCompatible).toBe(true);
    expect(readSpeechServerKey(SERVER).approvedKey).toBe('sk-new');
  });

  it('keeps approvals as bare origins in the owner-only file', () => {
    updateVoiceKeys({ openaiCompatible: 'sk-compat' }, 'HTTPS://user:pass@TTS.example.com:443/v1?token=x#y');
    const { keyId } = readSpeechServerKey(SERVER);
    expect(approveSpeechServer(SERVER, keyId)).toBe('added');
    expect(approveSpeechServer('https://tts.example.com:8443/other', keyId)).toBe('kept');
    expect(JSON.parse(fs.readFileSync(keysFile(), 'utf8'))).toEqual({
      openaiCompatible: 'sk-compat',
      openaiCompatibleOrigins: ['https://tts.example.com', 'https://tts.example.com:8443'],
    });
    if (process.platform !== 'win32') expect(fs.statSync(keysFile()).mode & 0o777).toBe(0o600);
  });

  it("a runtime's approvals do not apply to another runtime's key", () => {
    updateVoiceKeys({ openaiCompatible: 'sk-a' }, SERVER);
    const { keyId } = readSpeechServerKey(SERVER);
    process.env.OPENCHAMBER_DATA_DIR = path.join(dataDir, 'other');
    updateVoiceKeys({ openaiCompatible: 'sk-b' });
    expect(readSpeechServerKey(SERVER).approvedKey).toBeUndefined();
    expect(approveSpeechServer(SERVER, keyId)).toBe('refused');
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    expect(readSpeechServerKey(SERVER).approvedKey).toBe('sk-a');
  });
});
