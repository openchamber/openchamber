import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { browserVoiceService } from './browserVoiceService';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const restore = (key: 'window' | 'navigator', descriptor: PropertyDescriptor | undefined) => {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
};

afterEach(() => {
  mock.restore();
  restore('window', originalWindow);
  restore('navigator', originalNavigator);
});

const setupEmptyVoices = (platform: string, userAgent: string) => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform, userAgent } });
  spyOn(browserVoiceService, 'resumeAudioContext').mockResolvedValue();
  spyOn(browserVoiceService, 'waitForVoices').mockResolvedValue([]);
};

test('an empty voice list on desktop Linux rejects before taking playback ownership', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { speechSynthesis: {} } });
  setupEmptyVoices('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0');
  const beforePlayback = mock(async () => { throw new Error('Playback must not be prepared'); });

  await expect(browserVoiceService.speakText('Hello', 'en-US', undefined, { beforePlayback }))
    .rejects.toThrow('No browser speech synthesis voices are available');
  expect(beforePlayback).not.toHaveBeenCalled();
});

for (const [name, platform, userAgent] of [
  ['macOS', 'MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'],
  ['Android', 'Linux armv8l', 'Mozilla/5.0 (Linux; Android 15; Pixel 6) Chrome/140.0.0.0 Mobile'],
] as const) {
  test(`an empty voice list on ${name} still goes on to playback`, async () => {
    const sentinel = new Error('reached playback');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { speechSynthesis: {} } });
    setupEmptyVoices(platform, userAgent);
    const beforePlayback = mock(async () => { throw sentinel; });

    await expect(browserVoiceService.speakText('Hello', 'en-US', undefined, { beforePlayback }))
      .rejects.toThrow(sentinel.message);
    expect(beforePlayback).toHaveBeenCalledTimes(1);
  });
}
