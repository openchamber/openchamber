import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18nStore } from '@/lib/i18n/store';
import { AVAILABLE_LOCALES, LOCALE_LABELS, type Locale } from '@/lib/i18n/runtime';
import { settingsLanguage } from '@/lib/i18n/messages';

export const LanguageSettings: React.FC = () => {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{settingsLanguage()}</span>
        <span className="text-xs text-muted-foreground">
          {LOCALE_LABELS[locale]}
        </span>
      </div>
      <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AVAILABLE_LOCALES.map((loc) => (
            <SelectItem key={loc} value={loc}>
              {LOCALE_LABELS[loc]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};