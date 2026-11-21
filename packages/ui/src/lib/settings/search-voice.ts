import { useConfigStore } from '@/stores/useConfigStore';
import type { SettingsSearchItem } from './search';

export const VOICE_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'voice.playback',
    page: 'voice',
    titleKey: 'settings.voice.page.section.playbackAndSummary',
    keywords: ['tts', 'read aloud', 'voice', 'provider', 'speech rate', 'speech pitch', 'speech volume', 'tts input mode', 'markdown'],
  },
  {
    id: 'voice.auto-read-aloud',
    page: 'voice',
    titleKey: 'settings.voice.page.field.autoReadAloud',
    descriptionKey: 'settings.voice.page.tooltip.autoReadAloud',
    keywords: ['tts', 'read aloud', 'automatic', 'auto', 'speech', 'finished', 'reply'],
  },
  {
    id: 'voice.speech-recognition',
    page: 'voice',
    titleKey: 'settings.voice.page.section.speechRecognition',
    keywords: ['stt', 'dictation', 'voice input', 'transcribe', 'whisper', 'parakeet', 'qwen', 'microphone', 'misheard', 'correct', 'fix', 'small model'],
  },
  {
    id: 'voice.dictation-auto-send',
    page: 'voice',
    titleKey: 'settings.voice.page.field.dictationAutoSend',
    descriptionKey: 'settings.voice.page.field.dictationAutoSendInfo',
    keywords: ['dictation', 'voice input', 'send', 'submit', 'automatic'],
  },
  {
    id: 'voice.tts-endpoint-path',
    page: 'voice',
    titleKey: 'settings.voice.page.field.endpointPath',
    descriptionKey: 'settings.voice.page.field.endpointPathHint',
    keywords: ['tts', 'read aloud', 'endpoint path', 'custom endpoint', 'resource path'],
    isAvailable: (ctx) => {
      const state = ctx.voiceSettings ?? useConfigStore.getState();
      return (state.showMessageTTSButtons || state.autoReadAloudEnabled) && state.voiceProvider === 'openai-compatible';
    },
  },
  {
    id: 'voice.stt-endpoint-path',
    page: 'voice',
    titleKey: 'settings.voice.page.field.endpointPath',
    descriptionKey: 'settings.voice.page.field.endpointPathHint',
    keywords: ['stt', 'dictation', 'endpoint path', 'custom endpoint', 'resource path'],
    isAvailable: (ctx) => {
      const state = ctx.voiceSettings ?? useConfigStore.getState();
      return state.dictationEnabled && state.sttProvider === 'openai-compatible';
    },
  },
  {
    id: 'voice.stt-prompt',
    page: 'voice',
    titleKey: 'settings.voice.page.field.sttPrompt',
    descriptionKey: 'settings.voice.page.field.sttPromptHint',
    keywords: ['stt', 'dictation', 'prompt', 'vocabulary', 'terms', 'languages', 'whisper'],
    isAvailable: (ctx) => {
      const state = ctx.voiceSettings ?? useConfigStore.getState();
      return state.dictationEnabled && state.sttProvider === 'openai-compatible';
    },
  },
];
