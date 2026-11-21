import { updateIdleI18n } from '../ui/src/lib/i18n/messages/update-idle.i18n.ts';
import { getLocaleDirection } from '../ui/src/lib/i18n/runtime.ts';

const titles = {
  "en": "Install update",
  "de": "Update installieren",
  "fr": "Installer la mise à jour",
  "nl": "Update installeren",
  "es": "Instalar actualización",
  "ja": "アップデートをインストール",
  "pt-BR": "Instalar atualização",
  "uk": "Встановити оновлення",
  "ko": "업데이트 설치",
  "pl": "Zainstaluj aktualizację",
  "zh-CN": "安装更新",
  "zh-TW": "安裝更新",
  "tr": "Güncellemeyi kur",
  "ar": "تثبيت التحديث",
  "he": "התקנת עדכון"
};

const messages = (locale) => Object.hasOwn(updateIdleI18n, locale) ? updateIdleI18n[locale] : updateIdleI18n.en;

export const countdownText = (locale, seconds) => {
  const key = seconds === 1 ? 'updateDialog.idle.countingOne' : 'updateDialog.idle.counting';
  return messages(locale)[key].replace('{seconds}', () => String(seconds));
};

export const idleUpdateWindowHtml = ({ locale, seconds }) => {
  const escape = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const title = escape(Object.hasOwn(titles, locale) ? titles[locale] : titles.en);
  const body = escape(countdownText(locale, seconds));
  const cancel = escape(messages(locale)['updateDialog.actions.cancelIdleInstall']);
  return `<!doctype html>
<html lang="${escape(locale)}" dir="${getLocaleDirection(locale)}">
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: #1c1c1c; color: #f4f4f5; }
  main { padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  p { margin: 0; color: #d4d4d8; }
  a { align-self: flex-start; color: inherit; text-decoration: none; border: 1px solid #3f3f46; border-radius: 8px; padding: 6px 12px; }
</style>
<main>
  <h1>${title}</h1>
  <p id="countdown">${body}</p>
  <a href="https://idle-update.invalid/cancel">${cancel}</a>
</main>
</html>`;
};
