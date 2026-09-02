import { useUIStore } from '@/stores/useUIStore';

type NotificationSoundEvent =
  | 'completion'
  | 'subtask'
  | 'error'
  | 'question'
  | 'permission'
  | 'test';

export type NotificationSoundSettings = {
  notificationSoundEnabled: boolean;
  notificationInboxEnabled: boolean;
  notifyOnCompletion: boolean;
  notifyOnSubtasks: boolean;
  notifyOnError: boolean;
  notifyOnQuestion: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
};

const CHIME_COOLDOWN_MS = 700;

let sharedAudioContext: AudioContext | null = null;
let lastChimeAt = 0;
let unlockBound = false;

const isEventEnabled = (
  event: NotificationSoundEvent,
  settings: NotificationSoundSettings,
): boolean => {
  switch (event) {
    case 'test':
      return true;
    case 'completion':
      return settings.notifyOnCompletion;
    case 'subtask':
      return settings.notifyOnCompletion && settings.notifyOnSubtasks;
    case 'error':
      return settings.notifyOnError;
    case 'question':
    case 'permission':
      return settings.notifyOnQuestion;
  }
};

const isNotificationSoundContextFocused = (): boolean => {
  const documentRef = globalThis.document;
  if (!documentRef) return false;
  return documentRef.visibilityState === 'visible' && documentRef.hasFocus();
};

export const resolveOsNotificationSilent = (
  payload: { silent?: boolean } | undefined,
): boolean => payload?.silent === true;

export type NotificationSoundContext = {
  focused: boolean;
  viewingSession?: boolean;
};

export const shouldPlayNotificationSound = (
  event: NotificationSoundEvent,
  settings: NotificationSoundSettings,
  context: NotificationSoundContext,
): boolean => {
  if (!settings.notificationSoundEnabled) return false;
  if (event !== 'test' && !settings.notificationInboxEnabled) return false;
  if (!isEventEnabled(event, settings)) return false;
  if (event === 'test') return true;
  if (context.viewingSession && context.focused) return false;
  const osBannerWouldSound = settings.nativeNotificationsEnabled
    && (settings.notificationMode === 'always' || !context.focused);
  if (osBannerWouldSound) return false;
  return true;
};

const getSharedAudioContext = (): AudioContext | null => {
  const AudioContextCtor = globalThis.window?.AudioContext;
  if (!AudioContextCtor) return null;
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextCtor();
  }
  return sharedAudioContext;
};

const scheduleTone = (
  context: AudioContext,
  startAt: number,
  frequency: number,
  duration: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.07, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration);
};

const playNotificationChime = (): void => {
  const now = Date.now();
  if (now - lastChimeAt < CHIME_COOLDOWN_MS) return;
  const context = getSharedAudioContext();
  if (!context) return;
  lastChimeAt = now;
  void context.resume().then(() => {
    const startAt = context.currentTime;
    scheduleTone(context, startAt, 880, 0.12);
    scheduleTone(context, startAt + 0.09, 1175, 0.14);
  }).catch(() => {
    lastChimeAt = 0;
  });
};

const bindNotificationSoundUnlock = (): void => {
  const windowRef = globalThis.window;
  if (unlockBound || !windowRef) return;
  unlockBound = true;
  windowRef.addEventListener('pointerdown', () => {
    const context = getSharedAudioContext();
    if (!context || context.state !== 'suspended') return;
    void context.resume().catch(() => {});
  }, { once: true });
};

export const maybePlayNotificationSound = (
  event: NotificationSoundEvent,
  context?: Pick<NotificationSoundContext, 'viewingSession'>,
): void => {
  bindNotificationSoundUnlock();
  const settings = useUIStore.getState();
  if (!shouldPlayNotificationSound(event, settings, {
    focused: isNotificationSoundContextFocused(),
    viewingSession: context?.viewingSession === true,
  })) {
    return;
  }
  playNotificationChime();
};
