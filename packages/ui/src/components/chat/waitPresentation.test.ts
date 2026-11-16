import { describe, expect, test } from 'bun:test';

import type { I18nParams } from '@/lib/i18n';

import { timerMinutesLeft, waitOrigin, waitSubject } from './waitPresentation';

const t = (key: string, params?: I18nParams) => (params ? `${key}:${JSON.stringify(params)}` : key);

describe('wait presentation', () => {
  test('names the timer by its minutes in the user\'s language, never by the host\'s English label', () => {
    expect(waitSubject({ source: 'timer', title: 'Timer', label: '20 min', args: { minutes: 20 } }, t)).toBe('chat.waits.timer:{"minutes":20}');
    expect(waitSubject({ source: 'timer', title: 'Timer', label: '20 min' }, t)).toBe('chat.waits.source.timer');
  });

  test('names an extension\'s wait by its own title and label', () => {
    expect(waitSubject({ source: 'kit/deploy', title: 'Deploy', label: 'prod' }, t)).toBe('Deploy (prod)');
    expect(waitSubject({ source: 'kit/deploy', title: 'Deploy', label: null }, t)).toBe('Deploy');
  });

  test('counts a timer down in whole minutes, rounding up, and stops once it is due', () => {
    const timer = { source: 'timer', title: 'Timer', args: { minutes: 20 }, startedAt: 0 };
    expect(timerMinutesLeft(timer, 0)).toBe(20);
    expect(timerMinutesLeft(timer, 6 * 60_000 + 1)).toBe(14);
    expect(timerMinutesLeft(timer, 19 * 60_000 + 59_000)).toBe(1);
    expect(timerMinutesLeft(timer, 20 * 60_000)).toBeUndefined();
    expect(timerMinutesLeft({ source: 'kit/deploy', title: 'Deploy', startedAt: 0 }, 0)).toBeUndefined();
  });

  test('names the extension only for an extension\'s wait, never OpenChamber for its own', () => {
    expect(waitOrigin({ source: 'kit/deploy', title: 'Deploy', extension: 'Deploy Kit' })).toBe('Deploy Kit');
    expect(waitOrigin({ source: 'timer', title: 'Timer', extension: 'OpenChamber' })).toBeUndefined();
    expect(waitOrigin({ source: 'pr', title: '#7', extension: 'OpenChamber' })).toBeUndefined();
  });
});
