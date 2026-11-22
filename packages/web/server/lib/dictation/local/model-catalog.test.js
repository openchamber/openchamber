import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_TTS_MODEL,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_TTS_MODEL_CATALOG,
  getLocalSttModelSpec,
  getLocalTtsDefaultSpeaker,
  resolveLocalTtsModelForLanguage,
} from './model-catalog.js';

describe('local model catalog pins', () => {
  it('pins a byte size and sha256 for every STT and TTS archive', () => {
    for (const catalog of [LOCAL_STT_MODEL_CATALOG, LOCAL_TTS_MODEL_CATALOG]) {
      for (const [id, spec] of Object.entries(catalog)) {
        expect(Number.isInteger(spec.bytes) && spec.bytes > 0, id).toBe(true);
        expect(spec.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('getLocalSttModelSpec', () => {
  it('rejects Object.prototype member names with the unknown-id error (#988)', () => {
    for (const modelId of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(() => getLocalSttModelSpec(modelId), modelId).toThrowError(
        `Unknown local speech model id: ${modelId}`,
      );
    }
  });

  it('still resolves a real catalog id', () => {
    const [id] = Object.keys(LOCAL_STT_MODEL_CATALOG);
    const spec = getLocalSttModelSpec(id);
    expect(spec.id).toBe(id);
    expect(Array.isArray(spec.requiredFiles)).toBe(true);
  });
});

describe('local TTS catalog', () => {
  it('keeps the selected model when it speaks the language', () => {
    expect(resolveLocalTtsModelForLanguage('en', DEFAULT_LOCAL_TTS_MODEL)).toBe(DEFAULT_LOCAL_TTS_MODEL);
    expect(resolveLocalTtsModelForLanguage('zh', 'kokoro-multi-lang-v1_1')).toBe('kokoro-multi-lang-v1_1');
  });

  it('picks a catalog model for a language the selected model lacks', () => {
    expect(resolveLocalTtsModelForLanguage('uk', DEFAULT_LOCAL_TTS_MODEL)).toBe('piper-uk_UA-lada-x_low');
    expect(resolveLocalTtsModelForLanguage('zh', DEFAULT_LOCAL_TTS_MODEL)).toBe('kokoro-multi-lang-v1_1');
  });

  it('returns null for a language no model covers', () => {
    expect(resolveLocalTtsModelForLanguage('xx', DEFAULT_LOCAL_TTS_MODEL)).toBeNull();
  });

  it('gives Chinese a Chinese speaker on the multi-language Kokoro', () => {
    expect(getLocalTtsDefaultSpeaker('kokoro-multi-lang-v1_1', 'zh')).toBe(3);
    expect(getLocalTtsDefaultSpeaker('kokoro-multi-lang-v1_1', 'en')).toBe(0);
    expect(getLocalTtsDefaultSpeaker('piper-uk_UA-lada-x_low', 'uk')).toBeUndefined();
  });

  it('every TTS entry declares its languages and installable files', () => {
    for (const [id, spec] of Object.entries(LOCAL_TTS_MODEL_CATALOG)) {
      expect(spec.languages.length, id).toBeGreaterThan(0);
      expect(spec.archiveUrl, id).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\//);
      const resolved = getLocalSttModelSpec(id);
      expect(resolved.requiredFiles, id).toContain(spec.files.model);
      for (const key of spec.lexicon ?? []) {
        expect(spec.files[key], `${id} lexicon ${key}`).toBeTruthy();
      }
    }
  });
});
