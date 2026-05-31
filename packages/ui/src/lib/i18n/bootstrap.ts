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

export const getBootstrapMessages = (locale: Locale): BootstrapMessages => (locale === 'fr' ? FR_MESSAGES : EN_MESSAGES);

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
