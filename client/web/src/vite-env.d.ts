/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Public URL of the backend server (e.g. https://openchamber-backend.onrender.com).
   * When set, all API / auth / realtime traffic is routed to this origin instead
   * of same-origin. Leave unset for local development (Vite dev proxy handles it).
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
