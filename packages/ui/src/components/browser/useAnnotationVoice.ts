import React from 'react';

import { iconSpriteData } from '@/components/icon/sprite';
import type { BrowserAnnotationVoice } from '@/lib/browser/annotationOverlay';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { useI18n } from '@/lib/i18n';
import { parseShortcut } from '@/lib/shortcuts/bindings';
import { getEffectiveShortcutCombo } from '@/lib/shortcuts/schema';
import { isMacOS } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

export const toOverlayShortcut = (combo: string, mac: boolean): BrowserAnnotationVoice['shortcut'] => {
  const parsed = parseShortcut(combo);
  if (!parsed || parsed.chords.length !== 1) return null;
  const { modifiers, key } = parsed.chords[0];
  if (!/^[a-z0-9]$/.test(key)) return null;
  const mod = modifiers.has('mod');
  return {
    key,
    meta: mac ? mod : modifiers.has('super'),
    ctrl: mac ? modifiers.has('ctrl') : mod || modifiers.has('ctrl'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
  };
};

export const useAnnotationVoice = (): BrowserAnnotationVoice | null => {
  const { t } = useI18n();
  const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
  return React.useMemo(() => {
    if (!supported || !dictationEnabled) return null;
    return {
      shortcut: toOverlayShortcut(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides), isMacOS()),
      labels: {
        start: t('chat.dictation.start'),
        cancel: t('chat.dictation.cancel'),
        insert: t('chat.dictation.insert'),
        listening: t('chat.dictation.listening'),
        processing: t('chat.dictation.processing'),
      },
      icons: { mic: iconSpriteData.mic, close: iconSpriteData.close, check: iconSpriteData.check, loader: iconSpriteData['loader-4'] },
    };
  }, [dictationEnabled, shortcutOverrides, supported, t]);
};
