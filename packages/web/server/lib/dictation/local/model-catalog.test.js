import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_TTS_MODEL_CATALOG,
  RETIRED_LOCAL_MODEL_DIRS,
  getLocalSttModelSpec,
  getLocalTtsDefaultSpeaker,
  resolveLocalTtsModelForLanguage,
} from './model-catalog.js';

describe('local STT catalog', () => {
  // The files the recognizer engine reads for each model type.
  const filesByType = {
    nemo_transducer: ['encoder', 'decoder', 'joiner', 'tokens'],
    whisper: ['encoder', 'decoder', 'tokens'],
    qwen3_asr: ['convFrontend', 'encoder', 'decoder', 'tokenizer'],
  };

  it('every entry has the files its model type loads', () => {
    for (const [id, spec] of Object.entries(LOCAL_STT_MODEL_CATALOG)) {
      expect(Object.keys(spec.files).sort(), id).toEqual([...filesByType[spec.type]].sort());
      expect(spec.archiveUrl, id).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/asr-models\//);
    }
  });

  it('defaults to a catalog model', () => {
    expect(LOCAL_STT_MODEL_CATALOG[DEFAULT_LOCAL_STT_MODEL]).toBeDefined();
  });

  it('never deletes the directory of a model it still offers', () => {
    const offered = [...Object.values(LOCAL_STT_MODEL_CATALOG), ...Object.values(LOCAL_TTS_MODEL_CATALOG)]
      .map((spec) => spec.extractedDir);
    for (const dir of RETIRED_LOCAL_MODEL_DIRS) {
      expect(offered).not.toContain(dir);
    }
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
