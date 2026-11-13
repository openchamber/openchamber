// Fixed event text only. The repository reference is carried separately.
const titles = {
  en: { merged: 'Pull request merged', closed: 'Pull request closed', removed: 'Pull request no longer waiting to merge', 'checks-failed': 'Pull request checks failed' },
  de: { merged: 'Pull Request gemergt', closed: 'Pull Request geschlossen', removed: 'Pull Request wartet nicht mehr auf den Merge', 'checks-failed': 'Pull-Request-Prüfungen fehlgeschlagen' },
  fr: { merged: 'Pull request fusionnée', closed: 'Pull request fermée', removed: 'La pull request n\'attend plus la fusion', 'checks-failed': 'Échec des vérifications de la pull request' },
  nl: { merged: 'Pull request gemergd', closed: 'Pull request gesloten', removed: 'Pull request wacht niet meer op mergen', 'checks-failed': 'Controles van pull request mislukt' },
  es: { merged: 'Pull request fusionada', closed: 'Pull request cerrada', removed: 'La pull request ya no espera la fusión', 'checks-failed': 'Comprobaciones de la pull request fallidas' },
  ja: { merged: 'プルリクエストがマージされました', closed: 'プルリクエストがクローズされました', removed: 'プルリクエストのマージ待機が解除されました', 'checks-failed': 'プルリクエストのチェックが失敗しました' },
  'pt-BR': { merged: 'Pull request mesclada', closed: 'Pull request fechada', removed: 'A pull request não está mais aguardando merge', 'checks-failed': 'As verificações da pull request falharam' },
  uk: { merged: 'Pull request злито', closed: 'Pull request закрито', removed: 'Pull request більше не очікує злиття', 'checks-failed': 'Перевірки pull request не пройдено' },
  ko: { merged: '풀 리퀘스트가 병합되었습니다', closed: '풀 리퀘스트가 닫혔습니다', removed: '풀 리퀘스트가 더 이상 병합을 기다리지 않습니다', 'checks-failed': '풀 리퀘스트 검사 실패' },
  pl: { merged: 'Pull request scalony', closed: 'Pull request zamknięty', removed: 'Pull request nie oczekuje już na scalenie', 'checks-failed': 'Kontrole pull requesta nie powiodły się' },
  'zh-CN': { merged: '拉取请求已合并', closed: '拉取请求已关闭', removed: '拉取请求不再等待合并', 'checks-failed': '拉取请求检查失败' },
  'zh-TW': { merged: '提取請求已合併', closed: '提取請求已關閉', removed: '提取請求不再等待合併', 'checks-failed': '提取請求檢查失敗' },
  tr: { merged: 'Çekme isteği birleştirildi', closed: 'Çekme isteği kapatıldı', removed: 'Çekme isteği artık birleştirme beklemiyor', 'checks-failed': 'Çekme isteği denetimleri başarısız oldu' },
  ar: { merged: 'تم دمج طلب السحب', closed: 'تم إغلاق طلب السحب', removed: 'لم يعد طلب السحب ينتظر الدمج', 'checks-failed': 'فشلت فحوصات طلب السحب' },
  he: { merged: 'בקשת המשיכה מוזגה', closed: 'בקשת המשיכה נסגרה', removed: 'בקשת המשיכה כבר לא ממתינה למיזוג', 'checks-failed': 'בדיקות בקשת המשיכה נכשלו' },
};

export const pullRequestNotificationTitle = (locale, event) => (titles[locale] ?? titles.en)[event];
