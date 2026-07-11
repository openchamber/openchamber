// Points the client at a remote backend (e.g. the backend's public Render URL).
//
// The runtime reads `window.__OPENCHAMBER_API_BASE_URL__` to route all `/api`,
// `/auth`, `/health`, and realtime (WebSocket/SSE) traffic. We set it from the
// build-time `VITE_API_URL` env var so a deployed client can talk to a backend
// hosted on a different origin.
//
// When `VITE_API_URL` is unset (e.g. local dev), the value stays empty and the
// app falls back to same-origin requests (handled by the Vite dev proxy).
//
// This module has no imports and MUST be imported before `runtimeConfig` so the
// global is in place before `createConfiguredWebAPIs()` reads it.

const rawApiUrl = import.meta.env.VITE_API_URL;

if (typeof window !== 'undefined' && typeof rawApiUrl === 'string' && rawApiUrl.trim()) {
  if (!window.__OPENCHAMBER_API_BASE_URL__) {
    // Strip any trailing slash so URL joining stays predictable.
    window.__OPENCHAMBER_API_BASE_URL__ = rawApiUrl.trim().replace(/\/+$/, '');
  }
}

export {};
