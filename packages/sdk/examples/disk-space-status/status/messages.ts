import { z } from 'zod';

const localeSchema = z.enum(['en', 'nl', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW', 'ar', 'he']);
type Messages = {
  used: string; available: string; refresh: string; loading: string;
  unavailable: string; grant: string; project: string;
};

const messages = {
  en: { used: 'Used capacity', available: '{available} available · {total} total', refresh: 'Refresh', loading: 'Loading…', unavailable: 'Unavailable', grant: 'Allow the local service in Settings → Extensions.', project: 'Open a project to see disk space.' },
  nl: { used: 'Gebruikte ruimte', available: '{available} beschikbaar · {total} totaal', refresh: 'Vernieuwen', loading: 'Laden…', unavailable: 'Niet beschikbaar', grant: 'Sta de lokale service toe in Instellingen → Extensies.', project: 'Open een project om de schijfruimte te zien.' },
  de: { used: 'Belegter Speicher', available: '{available} verfügbar · {total} gesamt', refresh: 'Aktualisieren', loading: 'Wird geladen…', unavailable: 'Nicht verfügbar', grant: 'Erlaube den lokalen Dienst unter Einstellungen → Erweiterungen.', project: 'Öffne ein Projekt, um den Speicherplatz zu sehen.' },
  es: { used: 'Capacidad usada', available: '{available} disponibles · {total} en total', refresh: 'Actualizar', loading: 'Cargando…', unavailable: 'No disponible', grant: 'Permite el servicio local en Ajustes → Extensiones.', project: 'Abre un proyecto para ver el espacio en disco.' },
  fr: { used: 'Capacité utilisée', available: '{available} disponibles · {total} au total', refresh: 'Actualiser', loading: 'Chargement…', unavailable: 'Indisponible', grant: 'Autorisez le service local dans Paramètres → Extensions.', project: 'Ouvrez un projet pour voir l\'espace disque.' },
  ja: { used: '使用済み容量', available: '空き {available} · 合計 {total}', refresh: '更新', loading: '読み込み中…', unavailable: '利用できません', grant: '設定 → 拡張機能でローカルサービスを許可してください。', project: 'プロジェクトを開くとディスク容量が表示されます。' },
  ko: { used: '사용된 용량', available: '{available} 사용 가능 · 총 {total}', refresh: '새로고침', loading: '불러오는 중…', unavailable: '사용할 수 없음', grant: '설정 → 확장 기능에서 로컬 서비스를 허용하세요.', project: '디스크 공간을 보려면 프로젝트를 여세요.' },
  pl: { used: 'Zajęta pojemność', available: '{available} dostępne · {total} łącznie', refresh: 'Odśwież', loading: 'Ładowanie…', unavailable: 'Niedostępne', grant: 'Zezwól na usługę lokalną w Ustawienia → Rozszerzenia.', project: 'Otwórz projekt, aby zobaczyć miejsce na dysku.' },
  'pt-BR': { used: 'Capacidade usada', available: '{available} disponíveis · {total} no total', refresh: 'Atualizar', loading: 'Carregando…', unavailable: 'Indisponível', grant: 'Permita o serviço local em Configurações → Extensões.', project: 'Abra um projeto para ver o espaço em disco.' },
  tr: { used: 'Kullanılan kapasite', available: '{available} kullanılabilir · toplam {total}', refresh: 'Yenile', loading: 'Yükleniyor…', unavailable: 'Kullanılamıyor', grant: 'Ayarlar → Uzantılar bölümünde yerel hizmete izin verin.', project: 'Disk alanını görmek için bir proje açın.' },
  uk: { used: 'Зайнята місткість', available: '{available} доступно · {total} загалом', refresh: 'Оновити', loading: 'Завантаження…', unavailable: 'Недоступно', grant: 'Дозвольте локальну службу в Налаштування → Розширення.', project: 'Відкрийте проєкт, щоб побачити місце на диску.' },
  'zh-CN': { used: '已用容量', available: '可用 {available} · 总计 {total}', refresh: '刷新', loading: '加载中…', unavailable: '不可用', grant: '请在设置 → 扩展中允许本地服务。', project: '打开项目以查看磁盘空间。' },
  'zh-TW': { used: '已用容量', available: '可用 {available} · 總計 {total}', refresh: '重新整理', loading: '載入中…', unavailable: '無法使用', grant: '請在設定 → 擴充功能中允許本機服務。', project: '開啟專案以查看磁碟空間。' },
  ar: { used: 'السعة المستخدمة', available: '{available} متاح · {total} إجمالي', refresh: 'تحديث', loading: 'جارٍ التحميل…', unavailable: 'غير متاح', grant: 'اسمح بالخدمة المحلية في الإعدادات → الإضافات.', project: 'افتح مشروعًا لعرض مساحة القرص.' },
  he: { used: 'קיבולת בשימוש', available: '{available} פנוי · {total} בסך הכול', refresh: 'רענון', loading: 'בטעינה…', unavailable: 'לא זמין', grant: 'אפשרו את השירות המקומי בהגדרות → הרחבות.', project: 'פתחו פרויקט כדי לראות את שטח הדיסק.' },
} satisfies Record<z.infer<typeof localeSchema>, Messages>;

export const diskSpaceMessages = (locale: string): Messages => {
  const parsed = localeSchema.safeParse(locale);
  return messages[parsed.success ? parsed.data : 'en'];
};
