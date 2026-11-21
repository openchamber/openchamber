import { afterEach, describe, expect, test } from 'bun:test';

import { useConfigStore } from '@/stores/useConfigStore';
import { applySettingsToStores } from '@/lib/settings/registry';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { setTranscriptionPrompt } from '@/stores/useTranscriptionPromptStore';
import { getDictationStartOptions } from './useDictation';

describe('getDictationStartOptions', () => {
  const original = {
    sttProvider: useConfigStore.getState().sttProvider,
    sttServerUrl: useConfigStore.getState().sttServerUrl,
    sttModel: useConfigStore.getState().sttModel,
    sttLanguage: useConfigStore.getState().sttLanguage,
    sttEndpointPath: useConfigStore.getState().sttEndpointPath,
  };

  afterEach(() => {
    useConfigStore.setState(original);
    setTranscriptionPrompt('');
  });

  test('passes the custom stt endpoint path to the server', () => {
    useConfigStore.setState({
      sttProvider: 'openai-compatible',
      sttServerUrl: 'http://127.0.0.1:9/v1',
      sttModel: 'whisper-1',
      sttLanguage: 'en',
      sttEndpointPath: '/speech_to_text',
    });

    expect(getDictationStartOptions()).toEqual({
      provider: 'openai-compatible',
      language: 'en',
      openaiCompatible: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'whisper-1',
        endpointPath: '/speech_to_text',
      },
    });
  });

  test('leaves the path out when the setting is empty', () => {
    useConfigStore.setState({
      sttProvider: 'openai-compatible',
      sttServerUrl: 'http://127.0.0.1:9/v1',
      sttModel: 'whisper-1',
      sttLanguage: '',
      sttEndpointPath: '',
    });
    setTranscriptionPrompt('  \n ');

    expect(getDictationStartOptions()).toEqual({
      provider: 'openai-compatible',
      openaiCompatible: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'whisper-1',
        endpointPath: undefined,
      },
    });
  });

  test('sends the trimmed transcription prompt to a server provider only', () => {
    useConfigStore.setState({
      sttProvider: 'openai-compatible',
      sttServerUrl: 'http://127.0.0.1:9/v1',
      sttModel: 'whisper-1',
      sttLanguage: '',
      sttEndpointPath: '',
    });
    setTranscriptionPrompt('  Español e inglés.\nTérminos: OpenChamber  ');

    expect(getDictationStartOptions().openaiCompatible?.prompt).toBe('Español e inglés.\nTérminos: OpenChamber');

    useConfigStore.setState({ sttProvider: 'local' });
    expect(JSON.stringify(getDictationStartOptions())).not.toContain('prompt');
  });

  test('does not send the previous host\'s prompt after switching to a host that never saved one', () => {
    const previousApiBaseUrl = getRuntimeApiBaseUrl();
    const previousRuntimeKey = getRuntimeKey();
    useConfigStore.setState({ sttProvider: 'openai-compatible', sttServerUrl: 'https://stt.example/v1', sttModel: 'whisper-1' });
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://host-a.example', runtimeKey: 'host-a' });
      applySettingsToStores({ sttPrompt: 'Host A vocabulary' });
      expect(getDictationStartOptions().openaiCompatible?.prompt).toBe('Host A vocabulary');

      switchRuntimeEndpoint({ apiBaseUrl: 'https://host-b.example', runtimeKey: 'host-b' });
      applySettingsToStores({ sttLanguage: 'es' });
      expect(getDictationStartOptions().openaiCompatible).not.toHaveProperty('prompt');

      applySettingsToStores({ sttPrompt: 'Host B vocabulary' });
      applySettingsToStores({ sttLanguage: 'en' });
      expect(getDictationStartOptions().openaiCompatible?.prompt).toBe('Host B vocabulary');
    } finally {
      switchRuntimeEndpoint({ apiBaseUrl: previousApiBaseUrl, runtimeKey: previousRuntimeKey });
    }
  });
});
