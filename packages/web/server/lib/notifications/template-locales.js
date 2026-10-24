// The notification text OpenChamber writes itself, in the interface language.
//
// The server cannot reach `packages/ui`, so the defaults the settings page
// shows as placeholders (`settings.notifications.page.template.defaults.*`)
// are mirrored here. A missing or unknown tag falls back to English, which is
// what every build did before this list existed.

const en = {
  readyTitle: '{agent_name} is ready',
  readyMessage: '{model_name} completed the task',
  errorTitle: 'Tool error',
  errorBody: 'An error occurred',
  questionTitle: 'Input needed',
  questionBody: 'Agent is waiting for your response',
  permissionTitle: 'Permission required',
  permissionBody: 'Agent is waiting for your approval',
  planModeTitle: 'Switch to plan mode',
  buildModeTitle: 'Switch to build mode',
  workDoneTitle: 'Work looks done',
  reviewReadyTitle: 'Changes ready for review',
  waitingOnYouTitle: 'Waiting on you',
};

const de = {
  readyTitle: '{agent_name} ist bereit',
  readyMessage: '{model_name} hat die Aufgabe abgeschlossen',
  errorTitle: 'Werkzeugfehler',
  errorBody: 'Ein Fehler ist aufgetreten',
  questionTitle: 'Eingabe erforderlich',
  questionBody: 'Der Agent wartet auf deine Antwort',
  permissionTitle: 'Berechtigung erforderlich',
  permissionBody: 'Der Agent wartet auf deine Freigabe',
  planModeTitle: 'Zum Planmodus wechseln',
  buildModeTitle: 'Zum Build-Modus wechseln',
  workDoneTitle: 'Arbeit scheint abgeschlossen',
  reviewReadyTitle: 'Änderungen bereit zur Durchsicht',
  waitingOnYouTitle: 'Wartet auf dich',
};

const fr = {
  readyTitle: '{agent_name} est prêt',
  readyMessage: '{model_name} a terminé la tâche',
  errorTitle: "Erreur d'outil",
  errorBody: 'Une erreur est survenue',
  questionTitle: 'Entrée nécessaire',
  questionBody: "L'agent attend votre réponse",
  permissionTitle: 'Autorisation requise',
  permissionBody: "L'agent attend votre autorisation",
  planModeTitle: 'Passer en mode plan',
  buildModeTitle: 'Passer en mode build',
  workDoneTitle: 'Le travail semble terminé',
  reviewReadyTitle: 'Modifications prêtes pour relecture',
  waitingOnYouTitle: 'À vous de jouer',
};

const nl = {
  readyTitle: '{agent_name} is gereed',
  readyMessage: '{model_name} heeft de taak voltooid',
  errorTitle: 'Toolfout',
  errorBody: 'Er is een fout opgetreden',
  questionTitle: 'Invoer nodig',
  questionBody: 'De agent wacht op je antwoord',
  permissionTitle: 'Toestemming vereist',
  permissionBody: 'De agent wacht op je goedkeuring',
  planModeTitle: 'Naar planmodus schakelen',
  buildModeTitle: 'Naar buildmodus schakelen',
  workDoneTitle: 'Werk lijkt afgerond',
  reviewReadyTitle: 'Wijzigingen klaar voor review',
  waitingOnYouTitle: 'Wacht op jou',
};

const zhCN = {
  readyTitle: '{agent_name} 已完成',
  readyMessage: '{model_name} 已完成任务',
  errorTitle: '工具错误',
  errorBody: '发生错误',
  questionTitle: '需要输入',
  questionBody: '智能体正在等待你的回复',
  permissionTitle: '需要权限',
  permissionBody: '智能体正在等待你的批准',
  planModeTitle: '切换到 Plan 模式',
  buildModeTitle: '切换到 Build 模式',
  workDoneTitle: '工作看起来已完成',
  reviewReadyTitle: '有改动可查看',
  waitingOnYouTitle: '等你处理',
};

const zhTW = {
  readyTitle: '{agent_name} 已完成',
  readyMessage: '{model_name} 已完成任務',
  errorTitle: '工具錯誤',
  errorBody: '發生錯誤',
  questionTitle: '需要輸入',
  questionBody: '智慧體正在等待你的回覆',
  permissionTitle: '需要權限',
  permissionBody: '智慧體正在等待你的核准',
  planModeTitle: '切換到 Plan 模式',
  buildModeTitle: '切換到 Build 模式',
  workDoneTitle: '工作看起來已完成',
  reviewReadyTitle: '有變更可檢視',
  waitingOnYouTitle: '等你處理',
};

const uk = {
  readyTitle: '{agent_name} готовий',
  readyMessage: '{model_name} виконав завдання',
  errorTitle: 'Помилка інструменту',
  errorBody: 'Сталася помилка',
  questionTitle: 'Потрібна відповідь',
  questionBody: 'Агент чекає на вашу відповідь',
  permissionTitle: 'Потрібен дозвіл',
  permissionBody: 'Агент чекає на ваше схвалення',
  planModeTitle: 'Перейти в режим планування',
  buildModeTitle: 'Перейти в режим збирання',
  workDoneTitle: 'Роботу виглядає завершеною',
  reviewReadyTitle: 'Зміни готові до перегляду',
  waitingOnYouTitle: 'Чекаємо на вас',
};

const es = {
  readyTitle: '{agent_name} está listo',
  readyMessage: '{model_name} completó la tarea',
  errorTitle: 'Error de herramienta',
  errorBody: 'Se produjo un error',
  questionTitle: 'Entrada necesaria',
  questionBody: 'El agente espera tu respuesta',
  permissionTitle: 'Permiso necesario',
  permissionBody: 'El agente espera tu aprobación',
  planModeTitle: 'Cambiar al modo plan',
  buildModeTitle: 'Cambiar al modo build',
  workDoneTitle: 'El trabajo parece terminado',
  reviewReadyTitle: 'Cambios listos para revisar',
  waitingOnYouTitle: 'Te toca a ti',
};

const ptBR = {
  readyTitle: '{agent_name} está pronto',
  readyMessage: '{model_name} concluiu a tarefa',
  errorTitle: 'Erro de ferramenta',
  errorBody: 'Ocorreu um erro',
  questionTitle: 'Entrada necessária',
  questionBody: 'O agente está aguardando sua resposta',
  permissionTitle: 'Permissão necessária',
  permissionBody: 'O agente está aguardando sua aprovação',
  planModeTitle: 'Mudar para o modo plano',
  buildModeTitle: 'Mudar para o modo build',
  workDoneTitle: 'O trabalho parece concluído',
  reviewReadyTitle: 'Alterações prontas para revisão',
  waitingOnYouTitle: 'Esperando você',
};

const ko = {
  readyTitle: '{agent_name} 준비 완료',
  readyMessage: '{model_name}이(가) 작업을 완료했습니다',
  errorTitle: '도구 오류',
  errorBody: '오류가 발생했습니다',
  questionTitle: '입력이 필요합니다',
  questionBody: '에이전트가 답변을 기다리고 있습니다',
  permissionTitle: '권한 필요',
  permissionBody: '에이전트가 승인을 기다리고 있습니다',
  planModeTitle: 'Plan 모드로 전환',
  buildModeTitle: 'Build 모드로 전환',
  workDoneTitle: '작업이 완료된 것 같습니다',
  reviewReadyTitle: '검토할 변경 사항이 있습니다',
  waitingOnYouTitle: '사용자의 확인이 필요합니다',
};

const pl = {
  readyTitle: '{agent_name} jest gotowy',
  readyMessage: '{model_name} zakończył zadanie',
  errorTitle: 'Błąd narzędzia',
  errorBody: 'Wystąpił błąd',
  questionTitle: 'Wymagane dane wejściowe',
  questionBody: 'Agent czeka na Twoją odpowiedź',
  permissionTitle: 'Wymagane uprawnienie',
  permissionBody: 'Agent czeka na Twoją zgodę',
  planModeTitle: 'Przełącz na tryb planowania',
  buildModeTitle: 'Przełącz na tryb budowania',
  workDoneTitle: 'Praca wygląda na ukończoną',
  reviewReadyTitle: 'Zmiany gotowe do przeglądu',
  waitingOnYouTitle: 'Czekamy na ciebie',
};

const ja = {
  readyTitle: '{agent_name} の準備ができました',
  readyMessage: '{model_name} がタスクを完了しました',
  errorTitle: 'ツールエラー',
  errorBody: 'エラーが発生しました',
  questionTitle: '入力が必要です',
  questionBody: 'エージェントが回答を待っています',
  permissionTitle: '権限が必要です',
  permissionBody: 'エージェントが承認を待っています',
  planModeTitle: 'Plan モードに切り替え',
  buildModeTitle: 'Build モードに切り替え',
  workDoneTitle: '作業は完了したようです',
  reviewReadyTitle: 'レビューできる変更があります',
  waitingOnYouTitle: 'あなたの確認待ちです',
};

const tr = {
  readyTitle: '{agent_name} hazır',
  readyMessage: '{model_name} görevi tamamladı',
  errorTitle: 'Araç hatası',
  errorBody: 'Bir hata oluştu',
  questionTitle: 'Girdi gerekiyor',
  questionBody: 'Ajan yanıtınızı bekliyor',
  permissionTitle: 'İzin gerekiyor',
  permissionBody: 'Ajan onayınızı bekliyor',
  planModeTitle: 'Plan moduna geç',
  buildModeTitle: 'Build moduna geç',
  workDoneTitle: 'İş bitti görünüyor',
  reviewReadyTitle: 'İncelemeye hazır değişiklikler',
  waitingOnYouTitle: 'Seni bekliyor',
};

const ar = {
  readyTitle: '{agent_name} جاهز',
  readyMessage: 'أكمل {model_name} المهمة',
  errorTitle: 'خطأ في أداة',
  errorBody: 'حدث خطأ',
  questionTitle: 'مطلوب إدخال',
  questionBody: 'الوكيل بانتظار ردك',
  permissionTitle: 'مطلوب إذن',
  permissionBody: 'الوكيل بانتظار موافقتك',
  planModeTitle: 'التبديل إلى وضع التخطيط',
  buildModeTitle: 'التبديل إلى وضع البناء',
  workDoneTitle: 'يبدو العمل منجزًا',
  reviewReadyTitle: 'تغييرات جاهزة للمراجعة',
  waitingOnYouTitle: 'بانتظارك',
};

const he = {
  readyTitle: '{agent_name} מוכן',
  readyMessage: '{model_name} השלים את המשימה',
  errorTitle: 'שגיאת כלי',
  errorBody: 'אירעה שגיאה',
  questionTitle: 'נדרש קלט',
  questionBody: 'הסוכן ממתין לתשובתך',
  permissionTitle: 'נדרשת הרשאה',
  permissionBody: 'הסוכן ממתין לאישורך',
  planModeTitle: 'מעבר למצב תכנון',
  buildModeTitle: 'מעבר למצב בנייה',
  workDoneTitle: 'העבודה נראית גמורה',
  reviewReadyTitle: 'שינויים מוכנים לבדיקה',
  waitingOnYouTitle: 'מחכים לך',
};

export const NOTIFICATION_TEXT_BY_LOCALE = {
  en,
  de,
  fr,
  nl,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  uk,
  es,
  'pt-BR': ptBR,
  ko,
  pl,
  ja,
  tr,
  ar,
  he,
};

const DEFAULT_NOTIFICATION_LOCALE = 'en';

/**
 * Coerce a caller-supplied tag to one we have text for.
 *
 * Unknown, absent and malformed all collapse to English: the language is a
 * preference about wording, and a notification in English is a better answer
 * than one with no text at all.
 */
export function normalizeNotificationLocale(value) {
  const requested = value?.trim?.();
  if (!requested) return DEFAULT_NOTIFICATION_LOCALE;
  if (Object.hasOwn(NOTIFICATION_TEXT_BY_LOCALE, requested)) return requested;

  const normalized = requested.toLowerCase().replace(/_/g, '-');
  const tags = Object.keys(NOTIFICATION_TEXT_BY_LOCALE);
  const exact = tags.find((tag) => tag.toLowerCase() === normalized);
  if (exact) return exact;
  const regional = tags.find((tag) => normalized.startsWith(`${tag.toLowerCase()}-`));
  if (regional) return regional;
  const base = normalized.split('-')[0];
  return tags.find((tag) => tag.toLowerCase() === base) ?? DEFAULT_NOTIFICATION_LOCALE;
}

/** The text OpenChamber writes when the user left a template field empty. */
export function notificationTexts(locale) {
  return NOTIFICATION_TEXT_BY_LOCALE[normalizeNotificationLocale(locale)];
}

/**
 * The default template set for a language. The error and question bodies stay
 * `{last_message}`: those notifications exist to show what the agent said.
 */
export function defaultNotificationTemplates(locale) {
  const texts = notificationTexts(locale);
  return {
    completion: { title: texts.readyTitle, message: texts.readyMessage },
    error: { title: texts.errorTitle, message: '{last_message}' },
    question: { title: texts.questionTitle, message: '{last_message}' },
    subtask: { title: texts.readyTitle, message: texts.readyMessage },
    // A verdict exists to say what happened, so its body is the reply, like
    // the error and question bodies; the title carries the state.
    workDone: { title: texts.workDoneTitle, message: '{last_message}' },
    reviewReady: { title: texts.reviewReadyTitle, message: '{last_message}' },
    waitingOnYou: { title: texts.waitingOnYouTitle, message: '{last_message}' },
  };
}

/**
 * Render one of these texts. It is kept here, not taken from the template
 * runtime, because a default has to render even when template resolution is
 * the thing that failed.
 */
export function renderNotificationText(template, variables) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/**
 * A stored template entry with its empty fields replaced by the language's
 * default. An empty field is how the settings page shows "no custom text"
 * (it renders the default as the placeholder), so empty means default here
 * too — one field can be custom while the other still follows the language.
 */
export function withTemplateDefaults(entry, defaults) {
  const pick = (candidate, fallback) => (candidate?.trim?.() ? candidate : fallback);
  return {
    title: pick(entry?.title, defaults.title),
    message: pick(entry?.message, defaults.message),
  };
}
