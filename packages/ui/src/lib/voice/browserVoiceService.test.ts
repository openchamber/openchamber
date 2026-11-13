import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { browserVoiceService } from './browserVoiceService';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  mock.restore();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('an empty voice list rejects before taking playback ownership', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { speechSynthesis: {} } });
  spyOn(browserVoiceService, 'resumeAudioContext').mockResolvedValue();
  spyOn(browserVoiceService, 'waitForVoices').mockResolvedValue([]);
  const beforePlayback = mock(async () => { throw new Error('Playback must not be prepared'); });

  await expect(browserVoiceService.speakText('Hello', 'en-US', undefined, { beforePlayback }))
    .rejects.toThrow('No browser speech synthesis voices are available');
  expect(beforePlayback).not.toHaveBeenCalled();
});
