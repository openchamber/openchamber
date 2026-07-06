export type MobileLayoutPreference = 'default' | 'new';

const MOBILE_LAYOUT_PREFERENCE_KEY = 'openchamber-mobile-layout';

const normalizeMobileLayoutPreference = (value: unknown): MobileLayoutPreference => {
  // 'new' is the default; only an explicit 'default' (the legacy/"Old" layout)
  // opts out of it.
  return value === 'default' ? 'default' : 'new';
};

export const getStoredMobileLayoutPreference = (): MobileLayoutPreference => {
  if (typeof window === 'undefined') {
    return 'new';
  }

  try {
    return normalizeMobileLayoutPreference(window.localStorage.getItem(MOBILE_LAYOUT_PREFERENCE_KEY));
  } catch {
    return 'new';
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
