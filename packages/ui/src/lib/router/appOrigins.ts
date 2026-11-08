import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

/**
 * The addresses that serve this instance: the page and the server the app is
 * connected to. A web session link counts as this instance's only when it
 * points at one of them (`parseSessionLink`).
 */
export function appOwnOrigins(): string[] {
  try {
    return [window.location.origin, new URL(getRuntimeApiBaseUrl() || window.location.href, window.location.href).origin];
  } catch {
    return [window.location.origin];
  }
}
