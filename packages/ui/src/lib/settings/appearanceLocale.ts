import type { Locale } from '@/lib/i18n/runtime';
import { useI18nStore } from '@/lib/i18n/store';
import { updateDesktopSettings } from '@/lib/persistence';
import { captureRuntimeInstance } from '@/lib/runtime-switch';

export async function saveAppearanceLocale(locale: Locale): Promise<void> {
  const isCurrentRuntime = captureRuntimeInstance();
  if (await useI18nStore.getState().setLocale(locale) && isCurrentRuntime()) {
    await updateDesktopSettings({ locale });
  }
}
