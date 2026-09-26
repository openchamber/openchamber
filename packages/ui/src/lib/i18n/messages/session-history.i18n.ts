import type { Locale } from '../runtime';

const labels = (back: string, forward: string, failure: string, conflict: string) => ({
  'settings.openchamber.keyboardShortcuts.action.navigate_session_back.label': back,
  'settings.openchamber.keyboardShortcuts.action.navigate_session_forward.label': forward,
  'sessionHistory.lookupFailed': failure,
  'sessionHistory.defaultConflict': conflict,
});

export const sessionHistoryI18n = {
  en: labels('Back', 'Forward', 'Could not open this session. Try again.', 'Default shortcut is disabled because it conflicts with {action}.'),
  de: labels('Zurück', 'Vorwärts', 'Diese Sitzung konnte nicht geöffnet werden. Versuche es erneut.', 'Das Standardkürzel ist deaktiviert, da es mit {action} in Konflikt steht.'),
  es: labels('Atrás', 'Adelante', 'No se pudo abrir esta sesión. Inténtalo de nuevo.', 'El atajo predeterminado está desactivado porque entra en conflicto con {action}.'),
  fr: labels('Retour', 'Suivant', 'Impossible d’ouvrir cette session. Réessayez.', 'Le raccourci par défaut est désactivé, car il entre en conflit avec {action}.'),
  ja: labels('戻る', '進む', 'このセッションを開けませんでした。もう一度お試しください。', '既定のショートカットは「{action}」と競合するため無効になっています。'),
  ko: labels('뒤로', '앞으로', '이 세션을 열 수 없습니다. 다시 시도하세요.', '기본 단축키가 {action} 작업과 충돌하여 비활성화되었습니다.'),
  pl: labels('Wstecz', 'Dalej', 'Nie można otworzyć tej sesji. Spróbuj ponownie.', 'Domyślny skrót jest wyłączony, ponieważ koliduje z działaniem {action}.'),
  'pt-BR': labels('Voltar', 'Avançar', 'Não foi possível abrir esta sessão. Tente novamente.', 'O atalho padrão está desativado porque entra em conflito com {action}.'),
  tr: labels('Geri', 'İleri', 'Bu oturum açılamadı. Tekrar deneyin.', 'Varsayılan kısayol, {action} ile çakıştığı için devre dışı bırakıldı.'),
  uk: labels('Назад', 'Уперед', 'Не вдалося відкрити цей сеанс. Спробуйте ще раз.', 'Типове сполучення клавіш вимкнено через конфлікт із дією «{action}».'),
  'zh-CN': labels('后退', '前进', '无法打开此会话。请重试。', '默认快捷键与“{action}”冲突，已被禁用。'),
  'zh-TW': labels('返回', '前進', '無法開啟此工作階段。請再試一次。', '預設快捷鍵與「{action}」衝突，已停用。'),
} satisfies Record<Locale, ReturnType<typeof labels>>;
