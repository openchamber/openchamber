import { LOCALE_STORAGE_KEY, normalizeLocale, type Locale } from './runtime';

type BootstrapMessages = {
  startingApi: string;
  initializing: string;
  connecting: string;
  connected: string;
  connectionError: string;
  disconnected: string;
  reconnecting: string;
  initialDataLoadFailed: string;
  cliNotFound: string;
  providersReady: string;
  providersLoading: string;
  agentsReady: string;
  agentsLoading: string;
  startingDevServer: (hostLabel: string) => string;
  waitingDevServer: (hostLabel: string, attempt: number) => string;
  loadingData: (providersText: string, agentsText: string) => string;
};

const EN_MESSAGES: BootstrapMessages = {
  startingApi: 'Starting OpenCode API…',
  initializing: 'Initializing…',
  connecting: 'Connecting…',
  connected: 'Connected!',
  connectionError: 'Connection error',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  initialDataLoadFailed: 'OpenCode connected, but initial data load failed.',
  cliNotFound: 'OpenCode CLI not found. Please install it first.',
  providersReady: '✓ Providers',
  providersLoading: '… Providers',
  agentsReady: '✓ Agents',
  agentsLoading: '… Agents',
  startingDevServer: (hostLabel) => `Starting webview dev server (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Waiting for webview dev server (${hostLabel})... attempt ${attempt}`,
  loadingData: (providersText, agentsText) => `Loading data (${providersText}, ${agentsText})…`,
};

const FR_MESSAGES: BootstrapMessages = {
  startingApi: 'Démarrage de l’API OpenCode…',
  initializing: 'Initialisation…',
  connecting: 'Connexion…',
  connected: 'Connecté !',
  connectionError: 'Erreur de connexion',
  disconnected: 'Déconnecté',
  reconnecting: 'Reconnexion…',
  initialDataLoadFailed: 'OpenCode est connecté, mais le chargement initial des données a échoué.',
  cliNotFound: 'L’interface en ligne de commande OpenCode est introuvable. Veuillez l’installer d’abord.',
  providersReady: '✓ Fournisseurs',
  providersLoading: '… Fournisseurs',
  agentsReady: '✓ Agents',
  agentsLoading: '… Agents',
  startingDevServer: (hostLabel) => `Démarrage du serveur de développement de la webview (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `En attente du serveur de développement de la webview (${hostLabel})... tentative ${attempt}`,
  loadingData: (providersText, agentsText) => `Chargement des données (${providersText}, ${agentsText})…`,
};

const ZH_CN_MESSAGES: BootstrapMessages = {
  startingApi: '正在启动 OpenCode API…',
  initializing: '正在初始化…',
  connecting: '正在连接…',
  connected: '已连接！',
  connectionError: '连接错误',
  disconnected: '已断开连接',
  reconnecting: '正在重新连接…',
  initialDataLoadFailed: 'OpenCode 已连接，但初始数据加载失败。',
  cliNotFound: '未找到 OpenCode CLI。请先安装它。',
  providersReady: '✓ 提供商',
  providersLoading: '… 提供商',
  agentsReady: '✓ 智能体',
  agentsLoading: '… 智能体',
  startingDevServer: (hostLabel) => `正在启动 webview 开发服务器 (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `正在等待 webview 开发服务器 (${hostLabel})... 第 ${attempt} 次尝试`,
  loadingData: (providersText, agentsText) => `正在加载数据 (${providersText}, ${agentsText})…`,
};

const ZH_TW_MESSAGES: BootstrapMessages = {
  startingApi: '正在啟動 OpenCode API…',
  initializing: '正在初始化…',
  connecting: '正在連線…',
  connected: '已連線！',
  connectionError: '連線錯誤',
  disconnected: '已中斷連線',
  reconnecting: '正在重新連線…',
  initialDataLoadFailed: 'OpenCode 已連線，但初始資料載入失敗。',
  cliNotFound: '找不到 OpenCode CLI。請先安裝。',
  providersReady: '✓ 提供者',
  providersLoading: '… 提供者',
  agentsReady: '✓ 代理',
  agentsLoading: '… 代理',
  startingDevServer: (hostLabel) => `正在啟動 webview 開發伺服器 (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `正在等待 webview 開發伺服器 (${hostLabel})... 第 ${attempt} 次嘗試`,
  loadingData: (providersText, agentsText) => `正在載入資料 (${providersText}, ${agentsText})…`,
};

const UK_MESSAGES: BootstrapMessages = {
  startingApi: 'Запуск OpenCode API…',
  initializing: 'Ініціалізація…',
  connecting: 'Підключення…',
  connected: 'Підключено!',
  connectionError: 'Помилка підключення',
  disconnected: 'Відключено',
  reconnecting: 'Повторне підключення…',
  initialDataLoadFailed: 'OpenCode підключено, але початкове завантаження даних не вдалося.',
  cliNotFound: 'OpenCode CLI не знайдено. Спершу встановіть його.',
  providersReady: '✓ Провайдери',
  providersLoading: '… Провайдери',
  agentsReady: '✓ Агенти',
  agentsLoading: '… Агенти',
  startingDevServer: (hostLabel) => `Запуск dev-сервера webview (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Очікування dev-сервера webview (${hostLabel})... спроба ${attempt}`,
  loadingData: (providersText, agentsText) => `Завантаження даних (${providersText}, ${agentsText})…`,
};

const ES_MESSAGES: BootstrapMessages = {
  startingApi: 'Iniciando la API de OpenCode…',
  initializing: 'Inicializando…',
  connecting: 'Conectando…',
  connected: '¡Conectado!',
  connectionError: 'Error de conexión',
  disconnected: 'Desconectado',
  reconnecting: 'Reconectando…',
  initialDataLoadFailed: 'OpenCode se conectó, pero falló la carga inicial de datos.',
  cliNotFound: 'No se encontró OpenCode CLI. Instálalo primero.',
  providersReady: '✓ Proveedores',
  providersLoading: '… Proveedores',
  agentsReady: '✓ Agentes',
  agentsLoading: '… Agentes',
  startingDevServer: (hostLabel) => `Iniciando el servidor de desarrollo de webview (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Esperando el servidor de desarrollo de webview (${hostLabel})... intento ${attempt}`,
  loadingData: (providersText, agentsText) => `Cargando datos (${providersText}, ${agentsText})…`,
};

const PT_BR_MESSAGES: BootstrapMessages = {
  startingApi: 'Iniciando a API do OpenCode…',
  initializing: 'Inicializando…',
  connecting: 'Conectando…',
  connected: 'Conectado!',
  connectionError: 'Erro de conexão',
  disconnected: 'Desconectado',
  reconnecting: 'Reconectando…',
  initialDataLoadFailed: 'OpenCode conectado, mas o carregamento inicial dos dados falhou.',
  cliNotFound: 'OpenCode CLI não encontrado. Instale-o primeiro.',
  providersReady: '✓ Provedores',
  providersLoading: '… Provedores',
  agentsReady: '✓ Agentes',
  agentsLoading: '… Agentes',
  startingDevServer: (hostLabel) => `Iniciando o servidor de desenvolvimento da webview (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Aguardando o servidor de desenvolvimento da webview (${hostLabel})... tentativa ${attempt}`,
  loadingData: (providersText, agentsText) => `Carregando dados (${providersText}, ${agentsText})…`,
};

const KO_MESSAGES: BootstrapMessages = {
  startingApi: 'OpenCode API 시작 중…',
  initializing: '초기화 중…',
  connecting: '연결 중…',
  connected: '연결됨!',
  connectionError: '연결 오류',
  disconnected: '연결 끊김',
  reconnecting: '다시 연결 중…',
  initialDataLoadFailed: 'OpenCode에 연결되었지만 초기 데이터 로드에 실패했습니다.',
  cliNotFound: 'OpenCode CLI를 찾을 수 없습니다. 먼저 설치하세요.',
  providersReady: '✓ 공급자',
  providersLoading: '… 공급자',
  agentsReady: '✓ 에이전트',
  agentsLoading: '… 에이전트',
  startingDevServer: (hostLabel) => `webview 개발 서버 시작 중 (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `webview 개발 서버 대기 중 (${hostLabel})... ${attempt}번째 시도`,
  loadingData: (providersText, agentsText) => `데이터 로드 중 (${providersText}, ${agentsText})…`,
};

const PL_MESSAGES: BootstrapMessages = {
  startingApi: 'Uruchamianie API OpenCode…',
  initializing: 'Inicjalizacja…',
  connecting: 'Łączenie…',
  connected: 'Połączono!',
  connectionError: 'Błąd połączenia',
  disconnected: 'Rozłączono',
  reconnecting: 'Ponowne łączenie…',
  initialDataLoadFailed: 'OpenCode połączony, ale początkowe ładowanie danych nie powiodło się.',
  cliNotFound: 'Nie znaleziono OpenCode CLI. Najpierw go zainstaluj.',
  providersReady: '✓ Dostawcy',
  providersLoading: '… Dostawcy',
  agentsReady: '✓ Agenci',
  agentsLoading: '… Agenci',
  startingDevServer: (hostLabel) => `Uruchamianie serwera deweloperskiego webview (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Oczekiwanie na serwer deweloperski webview (${hostLabel})... próba ${attempt}`,
  loadingData: (providersText, agentsText) => `Ładowanie danych (${providersText}, ${agentsText})…`,
};

const RU_MESSAGES: BootstrapMessages = {
  startingApi: 'Запуск OpenCode API…',
  initializing: 'Инициализация…',
  connecting: 'Подключение…',
  connected: 'Подключено!',
  connectionError: 'Ошибка подключения',
  disconnected: 'Отключено',
  reconnecting: 'Повторное подключение…',
  initialDataLoadFailed: 'OpenCode подключён, но начальная загрузка данных не удалась.',
  cliNotFound: 'OpenCode CLI не найден. Сначала установите его.',
  providersReady: '✓ Провайдеры',
  providersLoading: '… Провайдеры',
  agentsReady: '✓ Агенты',
  agentsLoading: '… Агенты',
  startingDevServer: (hostLabel) => `Запуск dev-сервера webview (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Ожидание dev-сервера webview (${hostLabel})... попытка ${attempt}`,
  loadingData: (providersText, agentsText) => `Загрузка данных (${providersText}, ${agentsText})…`,
};

const JA_MESSAGES: BootstrapMessages = {
  startingApi: 'OpenCode API を起動中…',
  initializing: '初期化中…',
  connecting: '接続中…',
  connected: '接続完了！',
  connectionError: '接続エラー',
  disconnected: '切断されました',
  reconnecting: '再接続中…',
  initialDataLoadFailed: 'OpenCode に接続しましたが、初期データの読み込みに失敗しました。',
  cliNotFound: 'OpenCode CLI が見つかりません。先にインストールしてください。',
  providersReady: '✓ プロバイダ',
  providersLoading: '… プロバイダ',
  agentsReady: '✓ エージェント',
  agentsLoading: '… エージェント',
  startingDevServer: (hostLabel) => `Webview 開発サーバーを起動中 (${hostLabel})...`,
  waitingDevServer: (hostLabel, attempt) => `Webview 開発サーバーを待機中 (${hostLabel})... 試行 ${attempt}`,
  loadingData: (providersText, agentsText) => `データを読み込み中 (${providersText}, ${agentsText})…`,
};

export const getBootstrapMessages = (locale: Locale): BootstrapMessages => {
  return BOOTSTRAP_MESSAGES[locale];
};

const BOOTSTRAP_MESSAGES: Record<Locale, BootstrapMessages> = {
  en: EN_MESSAGES,
  fr: FR_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
  'zh-TW': ZH_TW_MESSAGES,
  uk: UK_MESSAGES,
  es: ES_MESSAGES,
  'pt-BR': PT_BR_MESSAGES,
  ko: KO_MESSAGES,
  pl: PL_MESSAGES,
  ja: JA_MESSAGES,
  ru: RU_MESSAGES,
};

export const readStoredLocaleForBootstrap = (): Locale => {
  if (typeof window === 'undefined') {
    return 'en';
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return 'en';
    }

    const parsed = JSON.parse(raw) as { locale?: unknown };
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : 'en';
  } catch {
    return 'en';
  }
};
