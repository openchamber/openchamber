export type MobileLayoutPreference = 'default' | 'new';

const MOBILE_LAYOUT_PREFERENCE_KEY = 'openchamber-mobile-layout';

export const normalizeMobileLayoutPreference = (value: unknown): MobileLayoutPreference => {
  return value === 'new' ? 'new' : 'default';
};

export const getStoredMobileLayoutPreference = (): MobileLayoutPreference => {
  if (typeof window === 'undefined') {
    return 'default';
  }

  try {
    return normalizeMobileLayoutPreference(window.localStorage.getItem(MOBILE_LAYOUT_PREFERENCE_KEY));
  } catch {
    return 'default';
  }
};

export const setStoredMobileLayoutPreference = (value: MobileLayoutPreference): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    window.localStorage.setItem(MOBILE_LAYOUT_PREFERENCE_KEY, value);
    return true;
  } catch {
    return false;
  }
};
