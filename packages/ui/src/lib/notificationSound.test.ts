import { describe, expect, test } from 'bun:test';
import {
  resolveOsNotificationSilent,
  shouldPlayNotificationSound,
  type NotificationSoundSettings,
} from './notificationSound';

const settings = (
  overrides: Partial<NotificationSoundSettings> = {},
): NotificationSoundSettings => ({
  notificationSoundEnabled: true,
  notificationInboxEnabled: true,
  notifyOnCompletion: true,
  notifyOnSubtasks: true,
  notifyOnError: true,
  notifyOnQuestion: true,
  nativeNotificationsEnabled: false,
  notificationMode: 'hidden-only',
  ...overrides,
});

describe('shouldPlayNotificationSound', () => {
  test('plays a focused session event when OS banners stay quiet', () => {
    expect(shouldPlayNotificationSound('completion', settings(), { focused: true })).toBe(true);
    expect(shouldPlayNotificationSound('error', settings(), { focused: true })).toBe(true);
    expect(shouldPlayNotificationSound('question', settings(), { focused: true })).toBe(true);
    expect(shouldPlayNotificationSound('permission', settings(), { focused: true })).toBe(true);
  });

  test('stays quiet when the setting is off', () => {
    expect(shouldPlayNotificationSound(
      'completion',
      settings({ notificationSoundEnabled: false }),
      { focused: true },
    )).toBe(false);
  });

  test('stays quiet when in-app history is off', () => {
    expect(shouldPlayNotificationSound(
      'completion',
      settings({ notificationInboxEnabled: false }),
      { focused: true },
    )).toBe(false);
  });

  test('plays when the window is in the background and OS banners stay quiet', () => {
    expect(shouldPlayNotificationSound('completion', settings(), { focused: false })).toBe(true);
    expect(shouldPlayNotificationSound(
      'completion',
      settings(),
      { focused: false, viewingSession: true },
    )).toBe(true);
  });

  test('stays quiet in the background when an OS banner would also sound', () => {
    expect(shouldPlayNotificationSound(
      'completion',
      settings({ nativeNotificationsEnabled: true, notificationMode: 'hidden-only' }),
      { focused: false },
    )).toBe(false);
  });

  test('lets the OS banner own the sound while focused and always-notify is on', () => {
    expect(shouldPlayNotificationSound(
      'completion',
      settings({
        nativeNotificationsEnabled: true,
        notificationMode: 'always',
      }),
      { focused: true },
    )).toBe(false);
  });

  test('still plays a test chime when OS banners would also sound', () => {
    expect(shouldPlayNotificationSound(
      'test',
      settings({
        nativeNotificationsEnabled: true,
        notificationMode: 'always',
      }),
      { focused: false },
    )).toBe(true);
  });

  test('stays quiet for the session the user is already watching', () => {
    expect(shouldPlayNotificationSound(
      'completion',
      settings(),
      { focused: true, viewingSession: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'error',
      settings(),
      { focused: true, viewingSession: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'question',
      settings(),
      { focused: true, viewingSession: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'permission',
      settings(),
      { focused: true, viewingSession: true },
    )).toBe(false);
  });

  test('follows the matching event toggle', () => {
    expect(shouldPlayNotificationSound(
      'completion',
      settings({ notifyOnCompletion: false }),
      { focused: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'subtask',
      settings({ notifyOnSubtasks: false }),
      { focused: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'subtask',
      settings({ notifyOnCompletion: false }),
      { focused: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'error',
      settings({ notifyOnError: false }),
      { focused: true },
    )).toBe(false);
    expect(shouldPlayNotificationSound(
      'question',
      settings({ notifyOnQuestion: false }),
      { focused: true },
    )).toBe(false);
  });
});

describe('resolveOsNotificationSilent', () => {
  test('only honors an explicit silent payload', () => {
    expect(resolveOsNotificationSilent({ silent: true })).toBe(true);
    expect(resolveOsNotificationSilent({ silent: false })).toBe(false);
    expect(resolveOsNotificationSilent(undefined)).toBe(false);
  });
});
