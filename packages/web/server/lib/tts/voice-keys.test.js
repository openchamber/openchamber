import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveProviderServer, approveSpeechServer, describeVoiceKeys, isProviderServerApproved, keyIdOf, readSpeechServerKey, readVoiceKey, updateVoiceKeys } from './voice-keys.js';

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

  describe('approvals for an OpenCode provider key', () => {
    const provider = { id: 'gateway', key: 'sk-gateway-madeup', credentialID: 'credential-1' };
    const ambient = { id: 'gateway', key: 'sk-gateway-madeup' };

    it('names the provider, the origin, the entry and a keyed digest of the key in the owner-only file, never the key', () => {
      expect(approveProviderServer(provider, 'HTTPS://user:pass@TTS.example.com:443/v1?token=x#y', keyIdOf(provider.key))).toBe('added');
      expect(approveProviderServer(provider, SERVER, keyIdOf(provider.key))).toBe('added');
      expect(approveProviderServer(provider, 'https://tts.example.com:8443/other', keyIdOf(provider.key))).toBe('kept');
      const stored = fs.readFileSync(keysFile(), 'utf8');
      const { identitySecret } = JSON.parse(stored);
      const digest = crypto.createHmac('sha256', identitySecret).update(provider.key).digest('base64url');
      expect(JSON.parse(stored)).toEqual({
        openaiCompatibleOrigins: [],
        identitySecret: expect.any(String),
        providerApprovals: [
          { provider: 'gateway', origin: 'https://tts.example.com', entry: 'credential-1', digest },
          { provider: 'gateway', origin: 'https://tts.example.com:8443', entry: 'credential-1', digest },
        ],
      });
      expect(stored).not.toContain(provider.key);
      expect(stored).not.toContain(crypto.createHash('sha256').update(provider.key).digest('base64url'));
      if (process.platform !== 'win32') expect(fs.statSync(keysFile()).mode & 0o777).toBe(0o600);
    });

    it('approves one provider for one origin, and nothing for the key of another provider', () => {
      approveProviderServer(provider, SERVER, keyIdOf(provider.key));
      expect(isProviderServerApproved(provider, 'https://tts.example.com:8443')).toBe(true);
      expect(isProviderServerApproved({ ...provider, id: 'other' }, 'https://tts.example.com:8443')).toBe(false);
      expect(isProviderServerApproved(provider, 'https://tts.example.com')).toBe(false);
    });

    it('does not carry over to another entry of the provider, to changed key bytes under the same entry, nor to a changed key without one', () => {
      approveProviderServer(provider, SERVER, keyIdOf(provider.key));
      expect(isProviderServerApproved({ ...provider, credentialID: 'credential-2' }, 'https://tts.example.com:8443')).toBe(false);
      expect(isProviderServerApproved({ ...provider, key: 'sk-gateway-replaced' }, 'https://tts.example.com:8443')).toBe(false);
      expect(isProviderServerApproved(provider, 'https://tts.example.com:8443')).toBe(true);

      approveProviderServer(ambient, SERVER, keyIdOf(ambient.key));
      expect(isProviderServerApproved({ ...ambient, key: 'sk-gateway-rotated' }, 'https://tts.example.com:8443')).toBe(false);
      expect(isProviderServerApproved(ambient, 'https://tts.example.com:8443')).toBe(true);
    });

    it('does not take the approval of a key held by an entry for the same key held without one', () => {
      approveProviderServer(provider, SERVER, keyIdOf(provider.key));
      expect(isProviderServerApproved(ambient, 'https://tts.example.com:8443')).toBe(false);
    });

    it('reads an approval from before the digest as approving nothing', () => {
      fs.writeFileSync(keysFile(), JSON.stringify({
        identitySecret: 'x'.repeat(43),
        providerApprovals: [{ provider: 'gateway', origin: 'https://tts.example.com:8443', credential: 'credential:credential-1' }],
      }));
      expect(isProviderServerApproved(provider, 'https://tts.example.com:8443')).toBe(false);
    });

    it('refuses a key id of another key and an address that is no http(s) origin', () => {
      expect(approveProviderServer(provider, SERVER, keyIdOf('sk-another'))).toBe('refused');
      expect(approveProviderServer(provider, SERVER, '')).toBe('refused');
      expect(approveProviderServer(provider, 'ftp://tts.example.com/v1', keyIdOf(provider.key))).toBe('refused');
      expect(approveProviderServer(provider, 'tts', keyIdOf(provider.key))).toBe('refused');
      expect(fs.existsSync(keysFile())).toBe(false);
    });

    it('survives typed keys being saved and removed, and reads damaged approvals as approving none', () => {
      approveProviderServer(provider, SERVER, keyIdOf(provider.key));
      updateVoiceKeys({ openaiCompatible: 'sk-compat' }, SERVER);
      updateVoiceKeys({ openaiCompatible: null });
      expect(isProviderServerApproved(provider, 'https://tts.example.com:8443')).toBe(true);

      const digest = 'digest';
      for (const approvals of ['gateway', [7], [{ provider: 'gateway' }], [{ provider: 'gateway', origin: 'tts', digest }], [{ provider: 'gateway', origin: SERVER, digest }], [{ provider: 'gateway', origin: 'https://tts.example.com:8443' }], null]) {
        fs.writeFileSync(keysFile(), JSON.stringify({ openaiCompatible: 'sk-compat', providerApprovals: approvals }));
        expect(isProviderServerApproved(provider, 'https://tts.example.com:8443')).toBe(false);
        expect(readVoiceKey('openaiCompatible')).toBe('sk-compat');
      }
    });
  });
});
