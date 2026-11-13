import { describe, expect, it } from 'vitest';

import { resolveModelLanguage } from './model-language.js';

describe('resolveModelLanguage', () => {
  it('passes a Whisper language code, reduced to its primary subtag', () => {
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', 'uk')).toBe('uk');
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', ' en-US ')).toBe('en');
  });

  it('drops a code Whisper does not know, which would exit the worker', () => {
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', 'xx')).toBe('');
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', 'auto')).toBe('');
  });

  it('passes Cantonese only to Whisper large-v3, which knows it', () => {
    expect(resolveModelLanguage('whisper-large-v3-turbo-int8', 'whisper', 'yue')).toBe('yue');
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', 'yue')).toBe('');
  });

  it('names the language for Qwen3-ASR and drops one it lacks', () => {
    expect(resolveModelLanguage('qwen3-asr-0.6b-int8', 'qwen3_asr', 'zh-CN')).toBe('Chinese');
    expect(resolveModelLanguage('qwen3-asr-0.6b-int8', 'qwen3_asr', 'uk')).toBe('');
  });

  it('gives Parakeet and an empty setting no hint', () => {
    expect(resolveModelLanguage('parakeet-tdt-0.6b-v3-int8', 'nemo_transducer', 'uk')).toBe('');
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', '')).toBe('');
    expect(resolveModelLanguage('whisper-tiny-int8', 'whisper', undefined)).toBe('');
  });
});
