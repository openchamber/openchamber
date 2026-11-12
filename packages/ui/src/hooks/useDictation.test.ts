import { afterEach, describe, expect, test } from 'bun:test';

import { useConfigStore } from '@/stores/useConfigStore';
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

    expect(getDictationStartOptions()).toEqual({
      provider: 'openai-compatible',
      openaiCompatible: {
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'whisper-1',
        endpointPath: undefined,
      },
    });
  });
});
