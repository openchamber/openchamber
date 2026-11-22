import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

export function appOwnOrigins(): string[] {
  try {
    return [window.location.origin, new URL(getRuntimeApiBaseUrl() || window.location.href, window.location.href).origin];
  } catch {
    return [window.location.origin];
  }
}
