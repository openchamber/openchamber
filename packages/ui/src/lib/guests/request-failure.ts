import type { useI18n } from '@/lib/i18n';

export type GuestRequestFailure = {
  method: 'GET' | 'POST';
  path: '/api/guests' | '/api/guests/upload';
} & (
  | { kind: 'network' }
  | { kind: 'http' | 'invalid-response'; status: number }
);

/** Diagnostics contain fixed routes and status codes, never credentials or response bodies. */
export const describeGuestRequestFailure = (failure: GuestRequestFailure, t: ReturnType<typeof useI18n>['t']): string => {
  const request = `${failure.method} ${failure.path}`;
  if (failure.kind === 'network') return `${request}: ${t('settings.extensions.request.noResponse')}`;
  if (failure.kind === 'invalid-response') {
    return `${request}: ${t('settings.extensions.request.invalidResponse', { status: failure.status })}`;
  }
  return `${request}: HTTP ${failure.status}`;
};
